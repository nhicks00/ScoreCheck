"""Protected deterministic complete-clip loader for causal-ball TRAIN/DEV data.

The sole public entry point accepts protected immutable-store coordinates.  It
loads the exact label pack first, rejects TEST and out-of-bound clips before
touching decoder or media stores, then consumes only the private capabilities
issued by :mod:`decoder_runtime` and :mod:`staged_media`.

V1 is intentionally narrow: one complete source clip, the statement's absolute
global video-stream index, preserved non-negative rational PTS, BT.709 limited
input converted to full-range RGB24 without autorotation or resizing, and a
static decoder runtime with no stored non-system dependencies.  The returned
tensor and receipt remain structural evidence only; every admission scope is
false.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import selectors
import signal
import stat
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterator

from .annotations import (
    AutorotationPolicy,
    BallFrameAnnotationV2,
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
from .artifact_store import MAX_ARTIFACT_FILES
from .ball_label_pack import (
    BallLabelPackError,
    _LoadedBallLabelPackEvidence,
    load_ball_label_pack,
)
from .clip_input_contract import (
    CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
    MAX_CLIP_INPUT_FLOAT32_BYTES,
    MAX_CLIP_INPUT_FRAMES,
    MAX_CLIP_INPUT_HEIGHT,
    MAX_CLIP_INPUT_PIXELS,
    MAX_CLIP_INPUT_RAW_RGB24_BYTES,
    MAX_CLIP_INPUT_WIDTH,
    CausalBallClipFrameBindingV1,
    CausalBallClipInputReceiptV1,
    ClipInputContractError,
    LoadedCausalBallClipInputV1,
    encode_rgb24_causal_ball_clip_input_v1,
    source_pts_to_timestamp_ns_v1,
)
from .contract_wire import (
    MAX_SIGNED_64,
    require_exact_int,
    require_sha256,
    require_stable_id,
)
from .capture_contracts import MAX_FINALIZED_SOURCE_BYTES
from .decoder_runtime import (
    MAX_DECODER_VERSION_OUTPUT_BYTES,
    DecoderRuntimeError,
    DecoderRuntimeManifestV1,
    _VerifiedDecoderRuntimeLease,
    load_verified_decoder_runtime,
    normalized_decoder_version_output_sha256,
)
from .immutable_store import generation_id_for
from .label_bundle import (
    BallFrameEnumerationV1,
    CausalBallLabelBundleV1,
    LabelBundleSplit,
)
from .staged_media import (
    StagedMediaError,
    _StagedVerifiedArtifactMediaV1,
    stage_verified_artifact_media_v1,
)


MAX_PROBE_STDOUT_BYTES = 1024 * 1024
MAX_PROCESS_STDERR_BYTES = 64 * 1024
MAX_FRAMEHASH_BYTES = 64 * 1024
PROBE_TIMEOUT_SECONDS = 60.0
DECODE_TIMEOUT_SECONDS = 300.0
PROCESS_TERMINATE_GRACE_SECONDS = 1.0

_READ_CHUNK_BYTES = 64 * 1024
_SELECT_POLL_SECONDS = 0.05
_FIXED_ENV = {
    "AV_LOG_FORCE_NOCOLOR": "1",
    "HOME": "/nonexistent",
    "LANG": "C",
    "LC_ALL": "C",
    "NO_COLOR": "1",
    "PATH": "/nonexistent",
    "TMPDIR": "/nonexistent",
    "TZ": "UTC",
}
_PROBE_MAXIMUM_DEPTH = 8
_PROBE_MAXIMUM_NODES = 8_192
_PROBE_MAXIMUM_CONTAINERS = 2_048
_ASCII_TOKEN_RE = re.compile(r"^[A-Za-z0-9_.:+-]{1,64}$")
_TIME_BASE_RE = re.compile(r"^([1-9][0-9]{0,18})/([1-9][0-9]{0,18})$")
_FRAMEHASH_ROW_RE = re.compile(
    r"^\s*0,\s*(-?[0-9]+),\s*(-?[0-9]+),\s*(-?[0-9]+),\s*([0-9]+),\s*([0-9a-f]{64})\s*$"
)
_FRAMEHASH_SOFTWARE_RE = re.compile(r"^#software: Lavf[A-Za-z0-9_.+-]{1,64}$")
_FRAMEHASH_COLUMNS = "#stream#, dts,        pts, duration,     size, hash"


class ClipLoaderError(ValueError):
    """Fail-closed clip-loader failure with a stable machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        normalized = code if code.startswith("CLIP_LOAD_") else f"CLIP_LOAD_{code}"
        self.code = normalized
        super().__init__(f"{normalized}: {message}")


def _fail(code: str, message: str) -> None:
    raise ClipLoaderError(code, message)


@dataclass(frozen=True, slots=True)
class _ClipPlanV1:
    statement: CausalBallLabelBundleV1
    statement_sha256: str
    decode_contract: FrameDecodeContract
    expected_identities: tuple[DecodedFrameIdentity, ...]
    expected_rows: tuple[BallFrameEnumerationV1, ...]
    frame_count: int
    width: int
    height: int
    frame_bytes: int
    raw_bytes: int


@dataclass(frozen=True, slots=True)
class _ProbeResultV1:
    selected_video_stream_index: int
    time_base_numerator: int
    time_base_denominator: int
    width: int
    height: int
    source_pts: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class _ProcessResult:
    returncode: int
    stdout: bytes
    stderr: bytes
    auxiliary: bytes


@dataclass(slots=True)
class _DrainState:
    name: str
    file: BinaryIO | None
    descriptor: int
    maximum_bytes: int
    data: bytearray
    total_bytes: int = 0
    overflowed: bool = False
    closed: bool = False

    def consume(self, chunk: bytes) -> None:
        self.total_bytes += len(chunk)
        remaining = self.maximum_bytes - len(self.data)
        if remaining > 0:
            self.data.extend(chunk[:remaining])
        if self.total_bytes > self.maximum_bytes:
            self.overflowed = True

    def close(self) -> bool:
        if self.closed:
            return True
        self.closed = True
        try:
            if self.file is not None:
                self.file.close()
            else:
                os.close(self.descriptor)
            return True
        except OSError:
            return False


def _require_false_admissions(
    value: object,
    *,
    label: str,
    code: str = "PACK_BINDING",
) -> None:
    for field_name in (
        "admissible_for_training",
        "admissible_for_evaluation",
        "admissible_for_test",
        "admissible_for_deployment",
        "admissible_for_live_scoring",
    ):
        if getattr(value, field_name, None) is not False:
            _fail(code, f"{label} admission flags must remain false")


def _annotation_identities(
    evidence: _LoadedBallLabelPackEvidence,
) -> dict[int, DecodedFrameIdentity]:
    identities: dict[int, DecodedFrameIdentity] = {}
    for annotation in evidence.annotations:
        if type(annotation) is not BallFrameAnnotationV2:
            _fail("PACK_BINDING", "label pack contains an unexpected annotation type")
        if type(annotation.frame) is not FrameReference:
            _fail("PACK_BINDING", "complete clip labels cannot contain unavailable frames")
        if annotation.frame.duplicate_kind is not FrameDuplicateKind.NONE:
            _fail(
                "PACK_BINDING",
                "V1 complete clips require every FrameReference duplicate kind NONE",
            )
        identity = annotation.frame.identity
        previous = identities.get(identity.frame_index)
        if previous is not None and previous != identity:
            _fail("FRAME_IDENTITY", "one frame index binds multiple decode identities")
        identities[identity.frame_index] = identity
    return identities


def _build_clip_plan(evidence: _LoadedBallLabelPackEvidence) -> _ClipPlanV1:
    if type(evidence) is not _LoadedBallLabelPackEvidence:
        _fail("PACK_BINDING", "label pack loader returned the wrong private type")
    _require_false_admissions(evidence, label="label pack")
    statement = evidence.statement
    if type(statement) is not CausalBallLabelBundleV1:
        _fail("PACK_BINDING", "label pack statement has the wrong exact type")
    if statement.split is LabelBundleSplit.TEST:
        _fail("TEST_FORBIDDEN", "TEST label packs cannot enter clip loading")
    if statement.split not in {LabelBundleSplit.TRAIN, LabelBundleSplit.DEV}:
        _fail("PACK_BINDING", "clip loading requires a TRAIN or DEV label pack")

    try:
        frame_count = require_exact_int(
            statement.frame_count,
            "frame_count",
            minimum=1,
            maximum=MAX_CLIP_INPUT_FRAMES,
        )
    except ValueError as exc:
        raise ClipLoaderError("BOUNDS", "clip frame count is outside V1 bounds") from exc
    if len(statement.frames) != frame_count:
        _fail("PACK_BINDING", "statement frame enumeration is incomplete")

    identities_by_index = _annotation_identities(evidence)
    if tuple(sorted(identities_by_index)) != tuple(range(frame_count)):
        _fail("PACK_BINDING", "annotations do not cover every complete clip frame")
    expected_identities = tuple(
        identities_by_index[index] for index in range(frame_count)
    )
    first = expected_identities[0]
    decode_contract = first.decode_contract
    if type(decode_contract) is not FrameDecodeContract:
        _fail("DECODE_CONTRACT", "frame identity has the wrong decode-contract type")
    width = decode_contract.output_width
    height = decode_contract.output_height
    try:
        require_exact_int(width, "output_width", minimum=16, maximum=MAX_CLIP_INPUT_WIDTH)
        require_exact_int(height, "output_height", minimum=16, maximum=MAX_CLIP_INPUT_HEIGHT)
    except ValueError as exc:
        raise ClipLoaderError("BOUNDS", "clip dimensions are outside V1 bounds") from exc
    if width % 4 or height % 4:
        _fail("BOUNDS", "clip dimensions must be divisible by four")
    pixels = frame_count * width * height
    if pixels > MAX_CLIP_INPUT_PIXELS:
        _fail("BOUNDS", "clip exceeds the V1 aggregate-pixel bound")
    frame_bytes = width * height * 3
    raw_bytes = frame_count * frame_bytes
    if raw_bytes > MAX_CLIP_INPUT_RAW_RGB24_BYTES:
        _fail("BOUNDS", "clip exceeds the V1 RGB24 byte bound")
    if pixels * 3 * 4 > MAX_CLIP_INPUT_FLOAT32_BYTES:
        _fail("BOUNDS", "clip exceeds the V1 float32 byte bound")

    if (
        decode_contract.autorotation_policy
        is not AutorotationPolicy.IGNORE_CONTAINER_DISPLAY_TRANSFORM
        or decode_contract.color_space is not DecodedColorSpace.BT709
        or decode_contract.color_range is not DecodedColorRange.LIMITED
        or decode_contract.output_pixel_format is not DecodedPixelFormat.RGB24
        or statement.timestamp_basis
        is not TimestampBasis.SOURCE_PRESENTATION_OFFSET_NS
        or statement.pixel_coordinate_space
        is not PixelCoordinateSpace.SOURCE_PIXEL_CENTERS_TOP_LEFT_X_RIGHT_Y_DOWN
        or statement.decoded_frame_hash_basis
        is not DecodedFrameHashBasis.RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING
    ):
        _fail(
            "DECODE_CONTRACT",
            "V1 requires noautorotate BT709 LIMITED source-grid RGB24 identities",
        )
    if decode_contract.fingerprint() != statement.decode_contract_sha256:
        _fail("DECODE_CONTRACT", "statement decode-contract digest is inconsistent")

    for index, (identity, row) in enumerate(
        zip(expected_identities, statement.frames, strict=True)
    ):
        if (
            type(identity) is not DecodedFrameIdentity
            or type(row) is not BallFrameEnumerationV1
            or identity.source_sha256 != statement.source_asset_sha256
            or identity.selected_video_stream_index
            != statement.selected_video_stream_index
            or identity.frame_index != index
            or identity.timestamp_ns != row.timestamp_ns
            or identity.timestamp_basis is not statement.timestamp_basis
            or identity.pixel_coordinate_space is not statement.pixel_coordinate_space
            or identity.decode_contract != decode_contract
            or identity.decoded_frame_sha256 != row.decoded_frame_sha256
            or identity.decoded_frame_hash_basis
            is not statement.decoded_frame_hash_basis
            or identity.fingerprint() != row.frame_identity_sha256
        ):
            _fail("FRAME_IDENTITY", "label statement frame identity is inconsistent")

    return _ClipPlanV1(
        statement=statement,
        statement_sha256=statement.fingerprint(),
        decode_contract=decode_contract,
        expected_identities=expected_identities,
        expected_rows=statement.frames,
        frame_count=frame_count,
        width=width,
        height=height,
        frame_bytes=frame_bytes,
        raw_bytes=raw_bytes,
    )


def _validate_post_pack_coordinates(
    *,
    plan: _ClipPlanV1,
    label_store_root: Path,
    artifact_store_root: Path,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    source_byte_length: int,
    runtime_store_root: Path,
    runtime_generation_id: str,
    runtime_manifest_sha256: str,
    expected_runtime_manifest_sha256: str,
    expected_platform: str,
    expected_architecture: str,
    expected_abi: str,
    expected_system_runtime_id: str,
    expected_system_runtime_measurement_sha256: str,
) -> None:
    try:
        if not isinstance(artifact_store_root, Path) or not isinstance(
            runtime_store_root, Path
        ):
            raise ValueError("store roots must be pathlib.Path values")
        for value, field_name in (
            (artifact_generation_id, "artifact_generation_id"),
            (runtime_generation_id, "runtime_generation_id"),
            (runtime_manifest_sha256, "runtime_manifest_sha256"),
            (expected_runtime_manifest_sha256, "expected_runtime_manifest_sha256"),
            (
                expected_system_runtime_measurement_sha256,
                "expected_system_runtime_measurement_sha256",
            ),
        ):
            require_sha256(value, field_name)
        for value, field_name in (
            (expected_platform, "expected_platform"),
            (expected_architecture, "expected_architecture"),
            (expected_abi, "expected_abi"),
            (expected_system_runtime_id, "expected_system_runtime_id"),
        ):
            require_stable_id(value, field_name)
        if (
            type(artifact_sha256s) is not tuple
            or not 1 <= len(artifact_sha256s) <= MAX_ARTIFACT_FILES
        ):
            raise ValueError("artifact tuple is outside its fixed bound")
        for digest in artifact_sha256s:
            require_sha256(digest, "artifact_sha256s entry")
        if artifact_sha256s != tuple(sorted(artifact_sha256s)) or len(
            set(artifact_sha256s)
        ) != len(artifact_sha256s):
            raise ValueError("artifact tuple must be sorted and unique")
        if generation_id_for(artifact_sha256s) != artifact_generation_id:
            raise ValueError("artifact generation does not commit the exact tuple")
        if plan.statement.source_asset_sha256 not in artifact_sha256s:
            raise ValueError("source asset is absent from the artifact generation")
        require_exact_int(
            source_byte_length,
            "source_byte_length",
            minimum=1,
            maximum=MAX_FINALIZED_SOURCE_BYTES,
        )
    except ValueError as exc:
        raise ClipLoaderError("CLIP_LOAD_INPUT", "clip-loader coordinates are invalid") from exc
    if runtime_manifest_sha256 != expected_runtime_manifest_sha256:
        _fail(
            "RUNTIME_BINDING",
            "runtime manifest coordinate differs from its independent pin",
        )
    _validate_distinct_store_namespaces(
        label_store_root,
        artifact_store_root,
        runtime_store_root,
    )


def _validate_distinct_store_namespaces(*roots: Path) -> None:
    identities: set[tuple[int, int]] = set()
    canonical_names: set[str] = set()
    try:
        for root in roots:
            if not isinstance(root, Path):
                raise ValueError("store root must be a pathlib.Path")
            link_value = root.lstat()
            value = root.stat()
            if (
                stat.S_ISLNK(link_value.st_mode)
                or not stat.S_ISDIR(link_value.st_mode)
                or not stat.S_ISDIR(value.st_mode)
            ):
                raise ValueError("store root must be a non-symlink directory")
            identity = (value.st_dev, value.st_ino)
            canonical = os.path.normcase(os.path.realpath(os.fspath(root))).casefold()
            if identity in identities or canonical in canonical_names:
                raise ValueError("protected store roots must be distinct namespaces")
            identities.add(identity)
            canonical_names.add(canonical)
    except OSError as exc:
        raise ClipLoaderError(
            "CLIP_LOAD_INPUT", "protected store roots are unavailable"
        ) from exc
    except ValueError as exc:
        raise ClipLoaderError(
            "CLIP_LOAD_INPUT", "protected store roots alias or are unsafe"
        ) from exc


def _exact_runtime_binding(
    runtime: _VerifiedDecoderRuntimeLease,
    plan: _ClipPlanV1,
) -> DecoderRuntimeManifestV1:
    if type(runtime) is not _VerifiedDecoderRuntimeLease:
        _fail("RUNTIME_BINDING", "runtime loader returned the wrong private type")
    _require_false_admissions(
        runtime,
        label="decoder runtime",
        code="RUNTIME_BINDING",
    )
    manifest = runtime._runtime_manifest()
    if type(manifest) is not DecoderRuntimeManifestV1:
        _fail("RUNTIME_BINDING", "runtime manifest has the wrong exact type")
    if manifest.dependency_closure != ():
        _fail(
            "RUNTIME_LINKAGE",
            "V1 execution requires an empty non-system dependency closure",
        )
    if manifest.system_runtime_measurement.allowed_install_names != (
        "/usr/lib/libSystem.B.dylib",
    ):
        _fail(
            "RUNTIME_LINKAGE",
            "V1 execution requires the exact static-system linkage allowlist",
        )
    source_digest = plan.statement.source_asset_sha256
    typed_runtime_digests = {
        runtime.generation_id,
        runtime.manifest_sha256,
        manifest.ffmpeg_object_sha256,
        manifest.ffprobe_object_sha256,
        manifest.ffmpeg_version_output_sha256,
        manifest.ffprobe_version_output_sha256,
        manifest.decoder_recipe_sha256,
        manifest.system_runtime_measurement.measurement_sha256,
        manifest.license_review_ref.removeprefix("sha256:"),
        *(item.object_sha256 for item in manifest.dependency_closure),
    }
    if source_digest in typed_runtime_digests:
        _fail("RUNTIME_BINDING", "source media aliases a typed runtime digest")
    expected_contract = FrameDecodeContract(
        decoder_artifact_sha256=runtime.manifest_sha256,
        decoder_build_id=manifest.runtime_id,
        autorotation_policy=AutorotationPolicy.IGNORE_CONTAINER_DISPLAY_TRANSFORM,
        color_space=DecodedColorSpace.BT709,
        color_range=DecodedColorRange.LIMITED,
        output_pixel_format=DecodedPixelFormat.RGB24,
        output_width=plan.width,
        output_height=plan.height,
    )
    if expected_contract != plan.decode_contract:
        _fail(
            "RUNTIME_BINDING",
            "pinned decoder runtime does not equal the label decode contract",
        )
    return manifest


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _parse_probe_integer(token: str) -> int:
    if len(token) > 20:
        raise ValueError("probe integer token exceeds its fixed grammar bound")
    # Preserve a one-step-outside signed-64 value long enough for the typed
    # stream/frame validator to classify PTS overflow as TIMESTAMP_BINDING.
    # Arbitrarily large integer tokens remain rejected at JSON protocol scope.
    return int(token, 10)


def _reject_probe_number(token: str) -> None:
    raise ValueError(f"unsupported probe number: {token}")


def _measure_probe_json(
    value: object,
    *,
    depth: int = 1,
) -> tuple[int, int]:
    if depth > _PROBE_MAXIMUM_DEPTH:
        raise ValueError("probe JSON is too deeply nested")
    nodes = 1
    containers = 0
    if type(value) is dict:
        containers = 1
        for key, item in value.items():
            if type(key) is not str:
                raise ValueError("probe JSON keys must be strings")
            child_nodes, child_containers = _measure_probe_json(
                item, depth=depth + 1
            )
            nodes += child_nodes
            containers += child_containers
    elif type(value) is list:
        containers = 1
        for item in value:
            child_nodes, child_containers = _measure_probe_json(
                item, depth=depth + 1
            )
            nodes += child_nodes
            containers += child_containers
    elif value is not None and type(value) not in {str, int, bool}:
        raise ValueError("probe JSON contains an unsupported value")
    if nodes > _PROBE_MAXIMUM_NODES or containers > _PROBE_MAXIMUM_CONTAINERS:
        raise ValueError("probe JSON exceeds fixed structural bounds")
    return nodes, containers


def _exact_dict(
    value: object,
    required: set[str],
    *,
    optional: set[str] = frozenset(),
) -> dict[str, Any]:
    if type(value) is not dict:
        raise ValueError("probe row must be an object")
    keys = set(value)
    if not required <= keys or keys - required - optional:
        raise ValueError("probe row fields are unsupported or incomplete")
    return value


def _bounded_ascii(value: object, *, maximum: int) -> str:
    if type(value) is not str or not 1 <= len(value) <= maximum:
        raise ValueError("probe string is outside its bound")
    try:
        raw = value.encode("ascii", errors="strict")
    except UnicodeEncodeError as exc:
        raise ValueError("probe string must be ASCII") from exc
    if any(byte not in {9, 10, 13} and not 0x20 <= byte <= 0x7E for byte in raw):
        raise ValueError("probe string contains a control character")
    return value


def _validate_probe_side_data(value: object, *, stream: bool) -> None:
    if type(value) is not list or len(value) > 16:
        raise ValueError("probe side-data list exceeds its bound")
    for item in value:
        if stream:
            fields = _exact_dict(item, {"rotation"})
            require_exact_int(
                fields["rotation"],
                "rotation",
                minimum=-MAX_SIGNED_64,
                maximum=MAX_SIGNED_64,
            )
            continue
        if type(item) is not dict or not item:
            raise ValueError("frame side data must be a non-empty object")
        allowed = {"side_data_type", "displaymatrix", "rotation"}
        if set(item) - allowed or "side_data_type" not in item:
            raise ValueError("frame side data has unsupported fields")
        side_type = _bounded_ascii(item["side_data_type"], maximum=128)
        if set(item) == {"side_data_type"}:
            if side_type != "H.26[45] User Data Unregistered SEI message":
                raise ValueError("frame side-data type is unsupported")
        elif set(item) == {"side_data_type", "displaymatrix", "rotation"}:
            if side_type != "3x3 displaymatrix":
                raise ValueError("display-matrix side-data type is invalid")
            _bounded_ascii(item["displaymatrix"], maximum=1024)
            require_exact_int(
                item["rotation"],
                "rotation",
                minimum=-MAX_SIGNED_64,
                maximum=MAX_SIGNED_64,
            )
        else:
            raise ValueError("frame side-data shape is unsupported")


def _parse_time_base(value: object) -> tuple[int, int]:
    if type(value) is not str:
        raise ValueError("time_base must be a string")
    match = _TIME_BASE_RE.fullmatch(value)
    if match is None:
        raise ValueError("time_base must be a positive rational")
    numerator = int(match.group(1), 10)
    denominator = int(match.group(2), 10)
    if (
        numerator > MAX_SIGNED_64
        or denominator > MAX_SIGNED_64
        or math.gcd(numerator, denominator) != 1
    ):
        raise ValueError("time_base must be reduced signed-64 rational")
    return numerator, denominator


def _parse_probe_output(
    raw: bytes,
    *,
    plan: _ClipPlanV1,
) -> _ProbeResultV1:
    try:
        if type(raw) is not bytes or not 1 <= len(raw) <= MAX_PROBE_STDOUT_BYTES:
            raise ValueError("probe output is outside its byte bound")
        payload = json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=_reject_duplicate_pairs,
            parse_int=_parse_probe_integer,
            parse_float=_reject_probe_number,
            parse_constant=_reject_probe_number,
        )
        _measure_probe_json(payload)
        top = _exact_dict(
            payload,
            {"frames", "programs", "stream_groups", "streams"},
        )
        if top["programs"] != [] or top["stream_groups"] != []:
            raise ValueError("program and stream-group surfaces must be empty")
        if type(top["streams"]) is not list or len(top["streams"]) != 1:
            raise ValueError("probe must return exactly one selected stream")
        stream = _exact_dict(
            top["streams"][0],
            {
                "index",
                "codec_type",
                "time_base",
                "width",
                "height",
                "pix_fmt",
                "color_space",
                "color_range",
                "start_pts",
            },
            optional={"side_data_list"},
        )
        if "side_data_list" in stream:
            _validate_probe_side_data(stream["side_data_list"], stream=True)
        selected = require_exact_int(
            stream["index"], "stream index", minimum=0, maximum=MAX_SIGNED_64
        )
        if (
            selected != plan.statement.selected_video_stream_index
            or stream["codec_type"] != "video"
            or stream["width"] != plan.width
            or stream["height"] != plan.height
            or stream["color_space"] != "bt709"
            or stream["color_range"] != "tv"
        ):
            raise ValueError("selected stream does not match the clip contract")
        pix_fmt = _bounded_ascii(stream["pix_fmt"], maximum=64)
        if _ASCII_TOKEN_RE.fullmatch(pix_fmt) is None:
            raise ValueError("source pixel format is not a normalized token")
        try:
            numerator, denominator = _parse_time_base(stream["time_base"])
            start_pts = require_exact_int(
                stream["start_pts"],
                "start_pts",
                minimum=0,
                maximum=MAX_SIGNED_64,
            )
        except ValueError as exc:
            raise ClipLoaderError(
                "TIMESTAMP_BINDING",
                "probe time base or start PTS is invalid",
            ) from exc

        frames = top["frames"]
        if type(frames) is not list or len(frames) != plan.frame_count:
            _fail("FRAME_COUNT", "probe frame count differs from the label statement")
        source_pts: list[int] = []
        for frame in frames:
            fields = _exact_dict(
                frame,
                {
                    "stream_index",
                    "pts",
                    "width",
                    "height",
                    "pix_fmt",
                    "color_space",
                    "color_range",
                },
                optional={"side_data_list"},
            )
            if "side_data_list" in fields:
                _validate_probe_side_data(fields["side_data_list"], stream=False)
            frame_stream_index = require_exact_int(
                fields["stream_index"],
                "frame stream_index",
                minimum=0,
                maximum=MAX_SIGNED_64,
            )
            try:
                pts = require_exact_int(
                    fields["pts"],
                    "frame pts",
                    minimum=0,
                    maximum=MAX_SIGNED_64,
                )
            except ValueError as exc:
                raise ClipLoaderError(
                    "TIMESTAMP_BINDING",
                    "probe frame PTS is outside the supported domain",
                ) from exc
            if (
                frame_stream_index != selected
                or fields["width"] != plan.width
                or fields["height"] != plan.height
                or fields["pix_fmt"] != pix_fmt
                or fields["color_space"] != "bt709"
                or fields["color_range"] != "tv"
            ):
                raise ValueError("probe frame changes stream decode properties")
            if source_pts and pts <= source_pts[-1]:
                _fail("TIMESTAMP_BINDING", "source PTS values must strictly increase")
            source_pts.append(pts)
        if not source_pts or source_pts[0] != start_pts:
            raise ValueError("stream start_pts does not equal the first complete frame")
        for pts, expected in zip(source_pts, plan.expected_rows, strict=True):
            try:
                timestamp_ns = source_pts_to_timestamp_ns_v1(
                    pts,
                    source_time_base_numerator=numerator,
                    source_time_base_denominator=denominator,
                )
            except ValueError as exc:
                raise ClipLoaderError(
                    "TIMESTAMP_BINDING",
                    "probe PTS maps outside the exact nanosecond domain",
                ) from exc
            if timestamp_ns != expected.timestamp_ns:
                _fail(
                    "TIMESTAMP_BINDING",
                    "preserved source PTS does not rebind label timestamps",
                )
        return _ProbeResultV1(
            selected_video_stream_index=selected,
            time_base_numerator=numerator,
            time_base_denominator=denominator,
            width=plan.width,
            height=plan.height,
            source_pts=tuple(source_pts),
        )
    except ClipLoaderError:
        raise
    except (KeyError, TypeError, UnicodeDecodeError, ValueError) as exc:
        raise ClipLoaderError("PROBE_PROTOCOL", "ffprobe output is invalid") from exc


def _parse_framehash_output(
    raw: bytes,
    *,
    probe: _ProbeResultV1,
    frame_sha256s: tuple[str, ...],
    frame_bytes: int,
) -> None:
    try:
        if type(raw) is not bytes or not 1 <= len(raw) <= MAX_FRAMEHASH_BYTES:
            raise ValueError("framehash output is outside its byte bound")
        text = raw.decode("ascii", errors="strict")
        if "\r" in text or "\x00" in text or not text.endswith("\n"):
            raise ValueError("framehash output must be canonical LF-delimited ASCII")
        lines = text[:-1].split("\n")
        if len(lines) != 10 + len(frame_sha256s):
            raise ValueError("framehash line count is invalid")
        expected_headers = (
            "#format: frame checksums",
            "#version: 2",
            "#hash: SHA256",
        )
        if tuple(lines[:3]) != expected_headers:
            raise ValueError("framehash fixed headers are invalid")
        if _FRAMEHASH_SOFTWARE_RE.fullmatch(lines[3]) is None:
            raise ValueError("framehash software header is invalid")
        time_base = f"{probe.time_base_numerator}/{probe.time_base_denominator}"
        if lines[4] != f"#tb 0: {time_base}":
            _fail("TIMESTAMP_BINDING", "framehash time base differs from probe")
        if lines[5] != "#media_type 0: video":
            raise ValueError("framehash media type is invalid")
        if lines[6] != "#codec_id 0: rawvideo":
            raise ValueError("framehash codec is invalid")
        if lines[7] != f"#dimensions 0: {probe.width}x{probe.height}":
            raise ValueError("framehash dimensions are invalid")
        if lines[8] != "#sar 0: 1/1" or lines[9] != _FRAMEHASH_COLUMNS:
            raise ValueError("framehash terminal headers are invalid")
        for line, expected_pts, expected_hash in zip(
            lines[10:], probe.source_pts, frame_sha256s, strict=True
        ):
            match = _FRAMEHASH_ROW_RE.fullmatch(line)
            if match is None:
                raise ValueError("framehash row grammar is invalid")
            dts, pts, duration, size = (
                int(match.group(index), 10) for index in range(1, 5)
            )
            if pts < 0 or dts < 0 or pts != expected_pts:
                _fail("TIMESTAMP_BINDING", "framehash PTS differs from probe")
            if (
                dts > MAX_SIGNED_64
                or pts > MAX_SIGNED_64
                or duration < -MAX_SIGNED_64 - 1
                or duration > MAX_SIGNED_64
                or size > MAX_SIGNED_64
                or dts != pts
                or size != frame_bytes
            ):
                raise ValueError("framehash timing or frame size is invalid")
            if match.group(5) != expected_hash:
                _fail("FRAME_HASH", "framehash digest differs from RGB24 bytes")
    except ClipLoaderError:
        raise
    except (UnicodeDecodeError, ValueError) as exc:
        raise ClipLoaderError("DECODE_PROTOCOL", "framehash output is invalid") from exc


def _process_group_exists(group_id: int) -> bool:
    try:
        os.killpg(group_id, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _terminate_process_group(process: subprocess.Popen[bytes]) -> bool:
    wait_ok = True
    # Reap an already-exited leader before probing its group.  On Darwin, an
    # unreaped session leader can make killpg(..., 0) report EPERM even when
    # no live descendant remains, which must not turn a successful bounded
    # shutdown into a false cleanup failure.
    process.poll()
    try:
        if _process_group_exists(process.pid):
            os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError:
        # Signal delivery can race a just-exited Darwin session leader.  Final
        # group disappearance, not the intermediate errno, is authoritative.
        pass
    grace_deadline = time.monotonic() + PROCESS_TERMINATE_GRACE_SECONDS
    while time.monotonic() < grace_deadline:
        process.poll()
        if not _process_group_exists(process.pid):
            break
        time.sleep(0.01)
    process.poll()
    try:
        if _process_group_exists(process.pid):
            os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except OSError:
        pass
    try:
        process.wait(timeout=PROCESS_TERMINATE_GRACE_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        wait_ok = False
    disappearance_deadline = time.monotonic() + PROCESS_TERMINATE_GRACE_SECONDS
    while time.monotonic() < disappearance_deadline:
        if not _process_group_exists(process.pid):
            return wait_ok
        time.sleep(0.01)
    return False


def _close_drain(
    selector: selectors.BaseSelector,
    state: _DrainState,
) -> bool:
    if state.closed:
        return True
    try:
        selector.unregister(state.descriptor)
    except (KeyError, OSError, ValueError):
        pass
    return state.close()


def _execute_process(
    argv: tuple[str, ...],
    *,
    pass_fds: tuple[int, ...],
    timeout_seconds: float,
    timeout_code: str,
    stdout_limit: int,
    auxiliary_read_fd: int = -1,
    auxiliary_write_fd: int = -1,
    auxiliary_limit: int = 0,
) -> _ProcessResult:
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    states: list[_DrainState] = []
    owned_auxiliary_read_fd = (
        auxiliary_read_fd
        if type(auxiliary_read_fd) is int and auxiliary_read_fd >= 0
        else -1
    )
    owned_auxiliary_write_fd = (
        auxiliary_write_fd
        if type(auxiliary_write_fd) is int and auxiliary_write_fd >= 0
        else -1
    )
    parent_write_closed = owned_auxiliary_write_fd < 0
    cleanup_ok = True
    timed_out = False
    overflowed = False
    deadline = 0.0
    try:
        # The auxiliary descriptors transfer to this function on a structurally
        # valid call boundary, including when the remaining invocation shape is
        # rejected.  Keep validation and every fallible path/executable/selector
        # check inside cleanup so the caller can relinquish numeric descriptor
        # values before calling without leaks or ambiguous close retries.
        has_auxiliary = (
            owned_auxiliary_read_fd >= 0 and owned_auxiliary_write_fd >= 0
        )
        if (
            type(argv) is not tuple
            or not argv
            or any(type(item) is not str or "\x00" in item for item in argv)
            or not Path(argv[0]).is_absolute()
            or type(pass_fds) is not tuple
            or any(type(item) is not int or item < 3 for item in pass_fds)
            or len(set(pass_fds)) != len(pass_fds)
            or type(timeout_seconds) is not float
            or not math.isfinite(timeout_seconds)
            or timeout_seconds <= 0.0
            or type(timeout_code) is not str
            or not timeout_code
            or type(stdout_limit) is not int
            or stdout_limit < 1
            or type(auxiliary_read_fd) is not int
            or type(auxiliary_write_fd) is not int
            or auxiliary_read_fd < -1
            or auxiliary_write_fd < -1
            or (auxiliary_read_fd >= 0) != (auxiliary_write_fd >= 0)
            or type(auxiliary_limit) is not int
            or (has_auxiliary and auxiliary_limit < 1)
            or (not has_auxiliary and auxiliary_limit != 0)
            or (
                has_auxiliary
                and (
                    auxiliary_read_fd < 3
                    or auxiliary_write_fd < 3
                    or auxiliary_read_fd == auxiliary_write_fd
                    or auxiliary_read_fd in pass_fds
                    or auxiliary_write_fd not in pass_fds
                )
            )
        ):
            _fail("PROCESS_START", "process invocation is not exact")
        deadline = time.monotonic() + timeout_seconds
        selector = selectors.DefaultSelector()
        executable = Path(argv[0])
        cwd = executable.parent
        try:
            cwd_value = cwd.lstat()
            executable_value = executable.lstat()
        except OSError as exc:
            raise ClipLoaderError(
                "PROCESS_START", "revalidated runtime paths are unavailable"
            ) from exc
        if (
            not stat.S_ISDIR(cwd_value.st_mode)
            or stat.S_IMODE(cwd_value.st_mode) != 0o500
            or not stat.S_ISREG(executable_value.st_mode)
            or stat.S_IMODE(executable_value.st_mode) != 0o500
        ):
            _fail("PROCESS_START", "runtime process cwd or executable mode is unsafe")
        try:
            process = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                close_fds=True,
                pass_fds=pass_fds,
                start_new_session=True,
                cwd=str(cwd),
                env=dict(_FIXED_ENV),
            )
        except (OSError, ValueError) as exc:
            raise ClipLoaderError("PROCESS_START", "pinned process could not start") from exc
        if auxiliary_write_fd >= 0:
            # Ownership of this numeric descriptor is consumed by this one
            # close attempt.  A close failure is ambiguous and must never be
            # retried after another thread could reuse the number.
            parent_write_closed = True
            try:
                os.close(auxiliary_write_fd)
            except OSError:
                _fail("CLEANUP", "parent framehash writer could not be closed")
        assert process.stdout is not None and process.stderr is not None
        states = [
            _DrainState(
                name="stdout",
                file=process.stdout,
                descriptor=process.stdout.fileno(),
                maximum_bytes=stdout_limit,
                data=bytearray(),
            ),
            _DrainState(
                name="stderr",
                file=process.stderr,
                descriptor=process.stderr.fileno(),
                maximum_bytes=MAX_PROCESS_STDERR_BYTES,
                data=bytearray(),
            ),
        ]
        if auxiliary_read_fd >= 0:
            states.append(
                _DrainState(
                    name="auxiliary",
                    file=None,
                    descriptor=auxiliary_read_fd,
                    maximum_bytes=auxiliary_limit,
                    data=bytearray(),
                )
            )
        for state in states:
            os.set_blocking(state.descriptor, False)
            selector.register(state.descriptor, selectors.EVENT_READ, state)

        while any(not state.closed for state in states) or process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0.0:
                timed_out = True
                break
            events = selector.select(timeout=min(_SELECT_POLL_SECONDS, remaining))
            for key, _ in events:
                state = key.data
                assert type(state) is _DrainState
                try:
                    chunk = os.read(state.descriptor, _READ_CHUNK_BYTES)
                except BlockingIOError:
                    continue
                except OSError:
                    cleanup_ok = False
                    _close_drain(selector, state)
                    continue
                if not chunk:
                    if not _close_drain(selector, state):
                        cleanup_ok = False
                    continue
                state.consume(chunk)
                if state.overflowed:
                    overflowed = True
            if overflowed:
                break

        if timed_out or overflowed:
            if not _terminate_process_group(process):
                cleanup_ok = False
        else:
            try:
                process.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
                if not _terminate_process_group(process):
                    cleanup_ok = False
        for state in states:
            if not _close_drain(selector, state):
                cleanup_ok = False
        if process.poll() is None:
            if not _terminate_process_group(process):
                cleanup_ok = False
        elif _process_group_exists(process.pid):
            # A pinned tool must not leave same-group descendants behind even
            # when the leader exited and every output pipe reached EOF.
            _terminate_process_group(process)
            cleanup_ok = False
        if not cleanup_ok:
            _fail("CLEANUP", "process descriptors or process group did not clean up")
        if timed_out:
            _fail(timeout_code, "pinned process exceeded its absolute deadline")
        if overflowed:
            _fail("OUTPUT_LIMIT", "pinned process exceeded a fixed output bound")
        return _ProcessResult(
            returncode=process.returncode,
            stdout=bytes(states[0].data),
            stderr=bytes(states[1].data),
            auxiliary=(bytes(states[2].data) if len(states) == 3 else b""),
        )
    except ClipLoaderError:
        if process is not None and (process.poll() is None or _process_group_exists(process.pid)):
            _terminate_process_group(process)
        raise
    except (OSError, ValueError) as exc:
        if process is not None and (
            process.poll() is None or _process_group_exists(process.pid)
        ):
            _terminate_process_group(process)
        raise ClipLoaderError(
            "CLEANUP", "process I/O or descriptor lifecycle failed"
        ) from exc
    finally:
        if selector is not None:
            selector.close()
        for state in states:
            state.close()
        if process is not None:
            represented = {state.file for state in states if state.file is not None}
            for stream in (process.stdout, process.stderr):
                if stream is not None and stream not in represented:
                    try:
                        stream.close()
                    except OSError:
                        pass
        if not parent_write_closed and owned_auxiliary_write_fd >= 0:
            parent_write_closed = True
            try:
                os.close(owned_auxiliary_write_fd)
            except OSError:
                pass
        if (
            owned_auxiliary_read_fd >= 0
            and not (
                owned_auxiliary_read_fd == owned_auxiliary_write_fd
                and parent_write_closed
            )
            and not any(
                state.descriptor == owned_auxiliary_read_fd for state in states
            )
        ):
            try:
                os.close(owned_auxiliary_read_fd)
            except OSError:
                pass


def _probe_clip(
    runtime: _VerifiedDecoderRuntimeLease,
    media: _StagedVerifiedArtifactMediaV1,
    plan: _ClipPlanV1,
) -> _ProbeResultV1:
    with media._open_immediate_child_reader() as input_fd:
        ffprobe = runtime._executable_path("ffprobe")
        argv = (
            str(ffprobe),
            "-v",
            "error",
            "-protocol_whitelist",
            "fd",
            "-fd",
            str(input_fd),
            "-select_streams",
            str(plan.statement.selected_video_stream_index),
            "-show_frames",
            "-show_entries",
            "stream=index,codec_type,time_base,width,height,pix_fmt,color_space,color_range,start_pts:stream_side_data=rotation:frame=stream_index,pts,width,height,pix_fmt,color_space,color_range",
            "-of",
            "json",
            "fd:",
        )
        result = _execute_process(
            argv,
            pass_fds=(input_fd,),
            timeout_seconds=PROBE_TIMEOUT_SECONDS,
            timeout_code="PROBE_TIMEOUT",
            stdout_limit=MAX_PROBE_STDOUT_BYTES,
        )
    if result.returncode != 0:
        _fail("PROBE_FAILED", "pinned ffprobe exited unsuccessfully")
    if result.stderr != b"" or result.auxiliary != b"":
        _fail("PROBE_PROTOCOL", "pinned ffprobe emitted an unexpected channel")
    return _parse_probe_output(result.stdout, plan=plan)


def _remeasure_runtime_versions(
    runtime: _VerifiedDecoderRuntimeLease,
    manifest: DecoderRuntimeManifestV1,
) -> None:
    """Execute both pinned tools before media staging and rebind version output."""

    for tool, expected_sha256 in (
        ("ffprobe", manifest.ffprobe_version_output_sha256),
        ("ffmpeg", manifest.ffmpeg_version_output_sha256),
    ):
        executable = runtime._executable_path(tool)
        result = _execute_process(
            (str(executable), "-hide_banner", "-version"),
            pass_fds=(),
            timeout_seconds=PROBE_TIMEOUT_SECONDS,
            timeout_code="PROBE_TIMEOUT",
            stdout_limit=MAX_DECODER_VERSION_OUTPUT_BYTES,
        )
        if result.returncode != 0 or result.stderr != b"" or result.auxiliary != b"":
            _fail("RUNTIME_BINDING", "pinned decoder version command failed")
        try:
            measured = normalized_decoder_version_output_sha256(result.stdout)
        except ValueError as exc:
            raise ClipLoaderError(
                "RUNTIME_BINDING", "pinned decoder version output is invalid"
            ) from exc
        if measured != expected_sha256:
            _fail("RUNTIME_BINDING", "pinned decoder version output changed")


def _decode_clip(
    runtime: _VerifiedDecoderRuntimeLease,
    media: _StagedVerifiedArtifactMediaV1,
    plan: _ClipPlanV1,
    probe: _ProbeResultV1,
) -> tuple[tuple[bytes, ...], tuple[str, ...]]:
    hash_read_fd = -1
    hash_write_fd = -1
    try:
        hash_read_fd, hash_write_fd = os.pipe()
        os.set_inheritable(hash_read_fd, False)
        os.set_inheritable(hash_write_fd, False)
        with media._open_immediate_child_reader() as input_fd:
            ffmpeg = runtime._executable_path("ffmpeg")
            stream = str(plan.statement.selected_video_stream_index)
            argv = (
                str(ffmpeg),
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
                str(input_fd),
                "-i",
                "fd:",
                "-filter_complex",
                f"[0:{stream}]scale=w=iw:h=ih:in_color_matrix=bt709:out_color_matrix=bt709:in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int+bitexact:sws_dither=none,format=pix_fmts=rgb24,split=outputs=2[raw][hash]",
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
                str(hash_write_fd),
                "fd:",
            )
            # Exact ownership of both pipe descriptors transfers to the runner.
            # Clear the caller's numeric values before the call: if runner close
            # reports an ambiguous failure, retrying here could close a foreign
            # descriptor that another thread obtained under the reused number.
            runner_hash_read_fd = hash_read_fd
            runner_hash_write_fd = hash_write_fd
            hash_read_fd = -1
            hash_write_fd = -1
            result = _execute_process(
                argv,
                pass_fds=(input_fd, runner_hash_write_fd),
                timeout_seconds=DECODE_TIMEOUT_SECONDS,
                timeout_code="DECODE_TIMEOUT",
                stdout_limit=plan.raw_bytes,
                auxiliary_read_fd=runner_hash_read_fd,
                auxiliary_write_fd=runner_hash_write_fd,
                auxiliary_limit=MAX_FRAMEHASH_BYTES,
            )
        if result.returncode != 0:
            _fail("DECODE_FAILED", "pinned ffmpeg exited unsuccessfully")
        if result.stderr != b"":
            _fail("DECODE_PROTOCOL", "pinned ffmpeg emitted unexpected stderr")
        if len(result.stdout) != plan.raw_bytes:
            _fail("FRAME_COUNT", "RGB24 output is not the exact complete clip length")
        frames = tuple(
            result.stdout[offset : offset + plan.frame_bytes]
            for offset in range(0, plan.raw_bytes, plan.frame_bytes)
        )
        if len(frames) != plan.frame_count:
            _fail("FRAME_COUNT", "RGB24 output frame count is incomplete")
        frame_sha256s = tuple(hashlib.sha256(frame).hexdigest() for frame in frames)
        _parse_framehash_output(
            result.auxiliary,
            probe=probe,
            frame_sha256s=frame_sha256s,
            frame_bytes=plan.frame_bytes,
        )
        return frames, frame_sha256s
    except ClipLoaderError:
        raise
    except OSError as exc:
        raise ClipLoaderError("PROCESS_START", "decode pipe setup failed") from exc
    finally:
        for descriptor in (hash_write_fd, hash_read_fd):
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass


def _rebuild_frame_bindings(
    *,
    plan: _ClipPlanV1,
    probe: _ProbeResultV1,
    frame_sha256s: tuple[str, ...],
) -> tuple[CausalBallClipFrameBindingV1, ...]:
    rows: list[CausalBallClipFrameBindingV1] = []
    for index, (source_pts, decoded_sha256, expected) in enumerate(
        zip(
            probe.source_pts,
            frame_sha256s,
            plan.expected_rows,
            strict=True,
        )
    ):
        timestamp_ns = source_pts_to_timestamp_ns_v1(
            source_pts,
            source_time_base_numerator=probe.time_base_numerator,
            source_time_base_denominator=probe.time_base_denominator,
        )
        identity = DecodedFrameIdentity(
            source_sha256=plan.statement.source_asset_sha256,
            selected_video_stream_index=probe.selected_video_stream_index,
            frame_index=index,
            timestamp_ns=timestamp_ns,
            timestamp_basis=plan.statement.timestamp_basis,
            pixel_coordinate_space=plan.statement.pixel_coordinate_space,
            decode_contract=plan.decode_contract,
            decoded_frame_sha256=decoded_sha256,
            decoded_frame_hash_basis=plan.statement.decoded_frame_hash_basis,
        )
        identity_sha256 = identity.fingerprint()
        if decoded_sha256 != expected.decoded_frame_sha256:
            _fail("FRAME_HASH", "decoded RGB24 frame differs from the label identity")
        if identity_sha256 != expected.frame_identity_sha256:
            _fail("FRAME_IDENTITY", "rebuilt frame identity differs from the label row")
        rows.append(
            CausalBallClipFrameBindingV1(
                frame_index=index,
                source_pts=source_pts,
                timestamp_ns=timestamp_ns,
                decoded_frame_sha256=decoded_sha256,
                frame_identity_sha256=identity_sha256,
            )
        )
    return tuple(rows)


def _load_private_core(
    *,
    evidence: _LoadedBallLabelPackEvidence,
    plan: _ClipPlanV1,
    runtime: _VerifiedDecoderRuntimeLease,
    runtime_manifest: DecoderRuntimeManifestV1,
    media: _StagedVerifiedArtifactMediaV1,
    source_byte_length: int,
) -> LoadedCausalBallClipInputV1:
    if (
        type(evidence) is not _LoadedBallLabelPackEvidence
        or type(plan) is not _ClipPlanV1
        or type(runtime) is not _VerifiedDecoderRuntimeLease
        or type(runtime_manifest) is not DecoderRuntimeManifestV1
        or type(media) is not _StagedVerifiedArtifactMediaV1
    ):
        _fail("CLIP_LOAD_INPUT", "clip loader core requires exact private capabilities")
    _require_false_admissions(
        runtime,
        label="decoder runtime",
        code="RUNTIME_BINDING",
    )
    _require_false_admissions(media, label="staged media", code="MEDIA_BINDING")
    if (
        media.source_sha256 != plan.statement.source_asset_sha256
        or media.source_byte_length != source_byte_length
    ):
        _fail("MEDIA_BINDING", "staged media differs from the label source")

    probe = _probe_clip(runtime, media, plan)
    frames, frame_sha256s = _decode_clip(runtime, media, plan, probe)
    frame_bindings = _rebuild_frame_bindings(
        plan=plan,
        probe=probe,
        frame_sha256s=frame_sha256s,
    )
    try:
        encoded = encode_rgb24_causal_ball_clip_input_v1(
            frames,
            output_width=plan.width,
            output_height=plan.height,
        )
    except (ClipInputContractError, RuntimeError, TypeError, ValueError) as exc:
        raise ClipLoaderError("TENSOR_ENCODING", "RGB24 tensor encoding failed") from exc

    try:
        receipt = CausalBallClipInputReceiptV1(
            label_pack_generation_id=evidence.generation_id,
            label_pack_sha256=evidence.pack_sha256,
            label_bundle_statement_sha256=plan.statement_sha256,
            bundle_id=plan.statement.bundle_id,
            source_asset_sha256=plan.statement.source_asset_sha256,
            split=plan.statement.split,
            finalized_trace_sha256=plan.statement.finalized_trace_sha256,
            capture_policy_sha256=plan.statement.capture_policy_sha256,
            capture_policy_generation=plan.statement.capture_policy_generation,
            artifact_generation_id=media.artifact_generation_id,
            source_byte_length=source_byte_length,
            decoder_runtime_generation_id=runtime.generation_id,
            decoder_runtime_manifest_sha256=runtime.manifest_sha256,
            decoder_runtime_id=runtime_manifest.runtime_id,
            decoder_recipe_sha256=runtime_manifest.decoder_recipe_sha256,
            decode_contract_sha256=plan.statement.decode_contract_sha256,
            selected_video_stream_index=probe.selected_video_stream_index,
            source_time_base_numerator=probe.time_base_numerator,
            source_time_base_denominator=probe.time_base_denominator,
            output_width=plan.width,
            output_height=plan.height,
            frame_count=plan.frame_count,
            frame_bindings=frame_bindings,
            input_encoding_sha256=CAUSAL_BALL_CLIP_INPUT_ENCODING_SHA256,
            input_tensor_sha256=encoded.input_tensor_sha256,
        )
        loaded = LoadedCausalBallClipInputV1(
            receipt=receipt,
            model_input=encoded.model_input,
        )
    except (ClipInputContractError, RuntimeError, TypeError, ValueError) as exc:
        raise ClipLoaderError("TENSOR_ENCODING", "receipt did not bind encoded tensor") from exc
    _require_false_admissions(
        loaded,
        label="loaded clip",
        code="TENSOR_ENCODING",
    )
    return loaded


def load_causal_ball_clip_input_v1(
    *,
    label_store_root: Path,
    label_pack_generation_id: str,
    label_pack_sha256: str,
    artifact_store_root: Path,
    artifact_generation_id: str,
    artifact_sha256s: tuple[str, ...],
    source_byte_length: int,
    runtime_store_root: Path,
    runtime_generation_id: str,
    runtime_manifest_sha256: str,
    expected_runtime_manifest_sha256: str,
    expected_platform: str,
    expected_architecture: str,
    expected_abi: str,
    expected_system_runtime_id: str,
    expected_system_runtime_measurement_sha256: str,
) -> LoadedCausalBallClipInputV1:
    """Load one exact complete TRAIN/DEV clip from immutable coordinates only."""

    try:
        evidence = load_ball_label_pack(
            label_store_root=label_store_root,
            generation_id=label_pack_generation_id,
            pack_sha256=label_pack_sha256,
        )
    except BallLabelPackError as exc:
        code = "INPUT" if exc.code == "BALL_LABEL_PACK_INPUT" else "PACK_BINDING"
        raise ClipLoaderError(code, "label pack verification failed") from exc
    plan = _build_clip_plan(evidence)
    _validate_post_pack_coordinates(
        plan=plan,
        label_store_root=label_store_root,
        artifact_store_root=artifact_store_root,
        artifact_generation_id=artifact_generation_id,
        artifact_sha256s=artifact_sha256s,
        source_byte_length=source_byte_length,
        runtime_store_root=runtime_store_root,
        runtime_generation_id=runtime_generation_id,
        runtime_manifest_sha256=runtime_manifest_sha256,
        expected_runtime_manifest_sha256=expected_runtime_manifest_sha256,
        expected_platform=expected_platform,
        expected_architecture=expected_architecture,
        expected_abi=expected_abi,
        expected_system_runtime_id=expected_system_runtime_id,
        expected_system_runtime_measurement_sha256=(
            expected_system_runtime_measurement_sha256
        ),
    )

    loaded: LoadedCausalBallClipInputV1 | None = None
    deferred_error: ClipLoaderError | DecoderRuntimeError | StagedMediaError | None = None
    try:
        with load_verified_decoder_runtime(
            runtime_store_root=runtime_store_root,
            generation_id=runtime_generation_id,
            manifest_sha256=runtime_manifest_sha256,
            expected_manifest_sha256=expected_runtime_manifest_sha256,
            expected_platform=expected_platform,
            expected_architecture=expected_architecture,
            expected_abi=expected_abi,
            expected_system_runtime_id=expected_system_runtime_id,
            expected_system_runtime_measurement_sha256=(
                expected_system_runtime_measurement_sha256
            ),
        ) as runtime:
            try:
                runtime_manifest = _exact_runtime_binding(runtime, plan)
                _remeasure_runtime_versions(runtime, runtime_manifest)
                try:
                    with stage_verified_artifact_media_v1(
                        artifact_store_root,
                        artifact_generation_id,
                        artifact_sha256s,
                        plan.statement.source_asset_sha256,
                        source_byte_length,
                    ) as media:
                        try:
                            loaded = _load_private_core(
                                evidence=evidence,
                                plan=plan,
                                runtime=runtime,
                                runtime_manifest=runtime_manifest,
                                media=media,
                                source_byte_length=source_byte_length,
                            )
                        except (
                            ClipLoaderError,
                            DecoderRuntimeError,
                            StagedMediaError,
                        ) as exc:
                            # Both capability context managers intentionally
                            # guard broad ValueError surfaces.  Defer our typed
                            # body error until both capabilities have cleaned
                            # up so it cannot be reclassified as store metadata.
                            deferred_error = exc
                except StagedMediaError as exc:
                    deferred_error = exc
            except (ClipLoaderError, DecoderRuntimeError) as exc:
                deferred_error = exc
    except ClipLoaderError:
        raise
    except DecoderRuntimeError as exc:
        code = (
            "CLEANUP"
            if exc.code == "CLEANUP"
            else (
                "RUNTIME_LINKAGE"
                if exc.code == "RUNTIME_LINKAGE"
                else "RUNTIME_BINDING"
            )
        )
        raise ClipLoaderError(code, "decoder runtime verification failed") from exc
    if type(deferred_error) is ClipLoaderError:
        raise deferred_error
    if type(deferred_error) is DecoderRuntimeError:
        code = "CLEANUP" if deferred_error.code == "CLEANUP" else "RUNTIME_BINDING"
        raise ClipLoaderError(code, "decoder runtime verification failed") from deferred_error
    if type(deferred_error) is StagedMediaError:
        code = "CLEANUP" if deferred_error.code == "MEDIA_CLEANUP" else "MEDIA_BINDING"
        raise ClipLoaderError(code, "artifact media verification failed") from deferred_error
    if type(loaded) is not LoadedCausalBallClipInputV1:
        _fail("CLEANUP", "clip capabilities closed without a loaded result")
    return loaded


__all__ = [
    "ClipLoaderError",
    "load_causal_ball_clip_input_v1",
]
