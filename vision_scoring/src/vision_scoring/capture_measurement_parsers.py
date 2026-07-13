"""Strict parsers for complete bounded finalized-source segment measurements.

The functions in this module parse only already-bounded process output.  They
do not execute a process, inspect stderr, open media, or grant admission or
scoring authority.  Presentation cadence is represented exclusively by the
``pts`` fields in ffprobe's presentation-ordered frame array.  Packet DTS and
framehash DTS are validated diagnostics and are never substituted for it.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import re
from typing import Any

from .capture_contracts import MAX_FINALIZED_FRAMES
from .capture_measurement_contracts import (
    MAX_DECODED_CAPTURE_MEASUREMENT_PACKETS as MAX_CAPTURE_MEASUREMENT_PACKETS,
)
from .capture_measurement_rows import (
    MAX_DECODED_DIMENSION_PX,
    DecodedFrameContentRowV1,
    DecodedFrameInterlaceFactV1,
    PresentationTimingRowV1,
    SelectedVideoPacketPayloadRowV1,
)
from .capture_profile_contracts import VideoCodecV1
from .contract_wire import MAX_SIGNED_64, MIN_SIGNED_64, require_exact_int


MAX_CAPTURE_MEASUREMENT_PRESENTATION_METADATA_BYTES = 8 * 1024 * 1024
MAX_CAPTURE_MEASUREMENT_SELECTED_PACKET_BYTES = 16 * 1024 * 1024
MAX_CAPTURE_MEASUREMENT_FRAMEHASH_BYTES = 1024 * 1024
_MAX_JSON_DEPTH = 8
_MAX_PRESENTATION_JSON_NODES = 131_072
_MAX_PRESENTATION_JSON_CONTAINERS = 16_384
_MAX_PACKET_JSON_NODES = 1_100_000
_MAX_PACKET_JSON_CONTAINERS = 70_000
_MAX_JSON_INTEGER_TOKEN_CHARACTERS = 20

_ASCII_TOKEN_RE = re.compile(r"^[A-Za-z0-9_.:+-]{1,64}$")
_DECIMAL_STRING_RE = re.compile(r"^(?:0|[1-9][0-9]{0,18})$")
_TIME_BASE_RE = re.compile(r"^([1-9][0-9]{0,18})/([1-9][0-9]{0,18})$")
_SAMPLE_ASPECT_RATIO_RE = re.compile(r"^([1-9][0-9]{0,18}):([1-9][0-9]{0,18})$")
_FRAMEHASH_SOFTWARE_RE = re.compile(
    r"^#software: Lavf[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$"
)
_FRAMEHASH_INTEGER = r"(?:0|-?[1-9][0-9]{0,18})"
_FRAMEHASH_ROW_RE = re.compile(
    rf"^0, +({_FRAMEHASH_INTEGER}), +({_FRAMEHASH_INTEGER}), +"
    rf"({_FRAMEHASH_INTEGER}), +((?:0|[1-9][0-9]{{0,18}})), +"
    r"([0-9a-f]{64})$"
)
_FRAMEHASH_COLUMNS = "#stream#, dts,        pts, duration,     size, hash"
_FRAMEHASH_FIXED_HEADERS = (
    "#format: frame checksums",
    "#version: 2",
    "#hash: SHA256",
)
_DISPLAY_ROTATIONS = frozenset({-270, -180, -90, 0, 90, 180, 270})
_INTERLACED_FIELD_ORDERS = frozenset({"tt", "bb", "tb", "bt"})
_CODEC_MAP = {
    "h264": VideoCodecV1.AVC_H264,
    "hevc": VideoCodecV1.HEVC_H265,
}
_AUTHORITY_FIELDS = (
    "admissible_for_training",
    "admissible_for_evaluation",
    "admissible_for_test",
    "admissible_for_deployment",
    "admissible_for_live_scoring",
)


def _canonical_row(value: object, row_type: type[Any], label: str) -> Any:
    if type(value) is not row_type:
        raise ValueError(f"{label} must have exact type {row_type.__name__}")
    try:
        reconstructed = row_type.from_json_bytes(value.to_json_bytes())
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"{label} is not a valid canonical row") from exc
    if reconstructed != value:
        raise ValueError(f"{label} canonical reconstruction changed the row")
    return reconstructed


@dataclass(frozen=True, slots=True)
class ParsedPresentationMetadataV1:
    """Structural metadata needed to bind framehash rows; never authority."""

    observed_codec: VideoCodecV1
    selected_video_stream_index: int
    source_time_base_numerator: int
    source_time_base_denominator: int
    decoded_width_px: int
    decoded_height_px: int
    sample_aspect_ratio_numerator: int
    sample_aspect_ratio_denominator: int
    display_rotation_degrees: int
    presentation_timing_rows: tuple[PresentationTimingRowV1, ...]
    frame_interlace_facts: tuple[DecodedFrameInterlaceFactV1, ...]
    admissible_for_training: bool = False
    admissible_for_evaluation: bool = False
    admissible_for_test: bool = False
    admissible_for_deployment: bool = False
    admissible_for_live_scoring: bool = False

    def __post_init__(self) -> None:
        if type(self.observed_codec) is not VideoCodecV1 or self.observed_codec not in {
            VideoCodecV1.AVC_H264,
            VideoCodecV1.HEVC_H265,
        }:
            raise ValueError("observed_codec must be exact AVC/H.264 or HEVC/H.265")
        selected = _require_stream_index(self.selected_video_stream_index)
        time_base = _require_time_base_parts(
            self.source_time_base_numerator,
            self.source_time_base_denominator,
        )
        width = require_exact_int(
            self.decoded_width_px,
            "decoded_width_px",
            minimum=1,
            maximum=MAX_DECODED_DIMENSION_PX,
        )
        height = require_exact_int(
            self.decoded_height_px,
            "decoded_height_px",
            minimum=1,
            maximum=MAX_DECODED_DIMENSION_PX,
        )
        del width, height
        _require_sample_aspect_ratio_parts(
            self.sample_aspect_ratio_numerator,
            self.sample_aspect_ratio_denominator,
        )
        rotation = require_exact_int(
            self.display_rotation_degrees,
            "display_rotation_degrees",
            minimum=0,
            maximum=270,
        )
        if rotation not in {0, 90, 180, 270}:
            raise ValueError("display rotation must be 0, 90, 180, or 270")
        if (
            type(self.presentation_timing_rows) is not tuple
            or not 1 <= len(self.presentation_timing_rows) <= MAX_FINALIZED_FRAMES
            or type(self.frame_interlace_facts) is not tuple
            or len(self.frame_interlace_facts) != len(self.presentation_timing_rows)
        ):
            raise ValueError("parsed presentation frame collections are invalid")
        observed_facts: set[DecodedFrameInterlaceFactV1] = set()
        for ordinal, (row_value, fact) in enumerate(
            zip(
                self.presentation_timing_rows,
                self.frame_interlace_facts,
                strict=True,
            )
        ):
            row = _canonical_row(
                row_value, PresentationTimingRowV1, "presentation timing row"
            )
            if (
                row.decoded_frame_ordinal != ordinal
                or row.selected_video_stream_index != selected
                or (
                    row.source_time_base_numerator,
                    row.source_time_base_denominator,
                )
                != time_base
            ):
                raise ValueError("parsed presentation timing rows are not exact")
            if type(fact) is not DecodedFrameInterlaceFactV1:
                raise ValueError("frame interlace fact has the wrong exact type")
            observed_facts.add(fact)
        if len(observed_facts) != 1:
            raise ValueError("frame interlace fact changed within the selected stream")
        for field in _AUTHORITY_FIELDS:
            if getattr(self, field) is not False:
                raise ValueError(f"{field} must be exactly false")

    @property
    def frame_count(self) -> int:
        return len(self.presentation_timing_rows)


def _require_stream_index(value: object) -> int:
    return require_exact_int(
        value,
        "selected_video_stream_index",
        minimum=0,
        maximum=MAX_SIGNED_64,
    )


def _reject_duplicate_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _parse_json_integer(token: str) -> int:
    if len(token) > _MAX_JSON_INTEGER_TOKEN_CHARACTERS:
        raise ValueError("JSON integer exceeds its lexical bound")
    value = int(token, 10)
    if not MIN_SIGNED_64 <= value <= MAX_SIGNED_64:
        raise ValueError("JSON integer is outside the signed-64 domain")
    return value


def _reject_json_number(token: str) -> None:
    raise ValueError(f"non-integer JSON number is unsupported: {token}")


def _preflight_json_depth(text: str) -> None:
    depth = 0
    in_string = False
    escaped = False
    for character in text:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > _MAX_JSON_DEPTH:
                raise ValueError("measurement JSON exceeds its depth bound")
        elif character in "]}":
            depth -= 1
            if depth < 0:
                raise ValueError("measurement JSON containers are unbalanced")


def _require_ascii_string(value: object, *, label: str, maximum: int) -> str:
    if type(value) is not str or not 1 <= len(value) <= maximum:
        raise ValueError(f"{label} is outside its string bound")
    try:
        raw = value.encode("ascii", errors="strict")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{label} must be ASCII") from exc
    if any(byte not in {9, 10, 13} and not 0x20 <= byte <= 0x7E for byte in raw):
        raise ValueError(f"{label} contains an unsupported control character")
    return value


def _require_bounded_utf8_string(
    value: object, *, label: str, maximum_characters: int, maximum_bytes: int
) -> str:
    if type(value) is not str or not 0 <= len(value) <= maximum_characters:
        raise ValueError(f"{label} is outside its character bound")
    try:
        raw = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ValueError(f"{label} must contain valid Unicode scalar values") from exc
    if len(raw) > maximum_bytes:
        raise ValueError(f"{label} is outside its UTF-8 byte bound")
    if any(
        ord(character) < 0x20 and character not in {"\t", "\n", "\r"}
        for character in value
    ):
        raise ValueError(f"{label} contains an unsupported control character")
    return value


def _measure_json(
    value: object,
    *,
    maximum_nodes: int,
    maximum_containers: int,
) -> None:
    nodes = 0
    containers = 0
    stack: list[tuple[object, int]] = [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if depth > _MAX_JSON_DEPTH:
            raise ValueError("measurement JSON exceeds its depth bound")
        nodes += 1
        if nodes > maximum_nodes:
            raise ValueError("measurement JSON exceeds its node bound")
        if type(item) is dict:
            containers += 1
            if containers > maximum_containers:
                raise ValueError("measurement JSON exceeds its container bound")
            for key, child in item.items():
                _require_ascii_string(key, label="JSON key", maximum=128)
                stack.append((child, depth + 1))
        elif type(item) is list:
            containers += 1
            if containers > maximum_containers:
                raise ValueError("measurement JSON exceeds its container bound")
            stack.extend((child, depth + 1) for child in item)
        elif type(item) is str:
            _require_bounded_utf8_string(
                item,
                label="JSON string",
                maximum_characters=4_096,
                maximum_bytes=16_384,
            )
        elif item is not None and type(item) not in {int, bool}:
            raise ValueError("measurement JSON contains an unsupported value")


def _parse_json(
    raw: bytes,
    *,
    maximum_bytes: int,
    maximum_nodes: int,
    maximum_containers: int,
) -> object:
    if type(raw) is not bytes or not 1 <= len(raw) <= maximum_bytes:
        raise ValueError("measurement JSON is outside its exact byte bound")
    text = raw.decode("utf-8", errors="strict")
    _preflight_json_depth(text)
    value = json.loads(
        text,
        object_pairs_hook=_reject_duplicate_pairs,
        parse_int=_parse_json_integer,
        parse_float=_reject_json_number,
        parse_constant=_reject_json_number,
    )
    _measure_json(
        value,
        maximum_nodes=maximum_nodes,
        maximum_containers=maximum_containers,
    )
    return value


def _exact_dict(
    value: object,
    required: set[str] | frozenset[str],
    *,
    optional: set[str] | frozenset[str] = frozenset(),
    label: str,
) -> dict[str, Any]:
    if type(value) is not dict:
        raise ValueError(f"{label} must be an object")
    fields = set(value)
    if not required <= fields or fields - required - optional:
        raise ValueError(f"{label} fields are unsupported or incomplete")
    return value


def _exact_list(value: object, *, label: str) -> list[Any]:
    if type(value) is not list:
        raise ValueError(f"{label} must be an array")
    return value


def _require_time_base_parts(numerator: object, denominator: object) -> tuple[int, int]:
    numerator_value = require_exact_int(
        numerator, "source_time_base_numerator", minimum=1, maximum=MAX_SIGNED_64
    )
    denominator_value = require_exact_int(
        denominator,
        "source_time_base_denominator",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    if math.gcd(numerator_value, denominator_value) != 1:
        raise ValueError("source time base must be a reduced positive rational")
    return numerator_value, denominator_value


def _parse_time_base(value: object) -> tuple[int, int]:
    if type(value) is not str:
        raise ValueError("time_base must be an ASCII rational string")
    match = _TIME_BASE_RE.fullmatch(value)
    if match is None:
        raise ValueError("time_base must be a positive decimal rational")
    return _require_time_base_parts(int(match.group(1), 10), int(match.group(2), 10))


def _require_sample_aspect_ratio_parts(
    numerator: object, denominator: object
) -> tuple[int, int]:
    numerator_value = require_exact_int(
        numerator,
        "sample_aspect_ratio_numerator",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    denominator_value = require_exact_int(
        denominator,
        "sample_aspect_ratio_denominator",
        minimum=1,
        maximum=MAX_SIGNED_64,
    )
    if math.gcd(numerator_value, denominator_value) != 1:
        raise ValueError("sample aspect ratio must be a reduced positive rational")
    return numerator_value, denominator_value


def _parse_sample_aspect_ratio(value: object) -> tuple[int, int]:
    if type(value) is not str:
        raise ValueError("sample_aspect_ratio must be an ASCII rational string")
    match = _SAMPLE_ASPECT_RATIO_RE.fullmatch(value)
    if match is None:
        raise ValueError("sample_aspect_ratio must be a positive decimal rational")
    return _require_sample_aspect_ratio_parts(
        int(match.group(1), 10), int(match.group(2), 10)
    )


def _optional_signed_int(fields: dict[str, Any], field: str) -> int | None:
    if field not in fields:
        return None
    return require_exact_int(
        fields[field], field, minimum=MIN_SIGNED_64, maximum=MAX_SIGNED_64
    )


def _decimal_string_int(value: object, *, label: str, minimum: int) -> int:
    if type(value) is not str or _DECIMAL_STRING_RE.fullmatch(value) is None:
        raise ValueError(f"{label} must be a canonical nonnegative decimal string")
    parsed = int(value, 10)
    if not minimum <= parsed <= MAX_SIGNED_64:
        raise ValueError(f"{label} is outside its signed-64 bound")
    return parsed


def _parse_rotation(value: object) -> int:
    raw = require_exact_int(
        value, "display rotation", minimum=-MAX_SIGNED_64, maximum=MAX_SIGNED_64
    )
    if raw not in _DISPLAY_ROTATIONS:
        raise ValueError("display rotation is outside the fixed quarter-turn domain")
    return raw % 360


def _metadata_stream_rotation(value: object) -> int | None:
    entries = _exact_list(value, label="stream side_data_list")
    if len(entries) != 1:
        raise ValueError("stream rotation side data is ambiguous")
    item = _exact_dict(entries[0], {"rotation"}, label="stream rotation side data")
    return _parse_rotation(item["rotation"])


def _validate_display_matrix(value: object) -> None:
    matrix = _require_ascii_string(value, label="display matrix", maximum=2_048)
    if not matrix.startswith("\n") or not matrix.endswith("\n"):
        raise ValueError("display matrix text is not canonical")


def _frame_rotation(value: object) -> int | None:
    entries = _exact_list(value, label="frame side_data_list")
    if not 1 <= len(entries) <= 16:
        raise ValueError("frame side data is outside its row bound")
    rotation: int | None = None
    for entry in entries:
        if type(entry) is not dict or "side_data_type" not in entry:
            raise ValueError("frame side data has an invalid shape")
        side_type = _require_ascii_string(
            entry["side_data_type"], label="frame side-data type", maximum=128
        )
        if side_type == "H.26[45] User Data Unregistered SEI message":
            _exact_dict(
                entry,
                {"side_data_type"},
                label="unregistered user-data side data",
            )
        elif side_type == "3x3 displaymatrix":
            fields = _exact_dict(
                entry,
                {"side_data_type", "displaymatrix", "rotation"},
                label="frame display-matrix side data",
            )
            if rotation is not None:
                raise ValueError("frame contains ambiguous display rotations")
            _validate_display_matrix(fields["displaymatrix"])
            rotation = _parse_rotation(fields["rotation"])
        else:
            raise ValueError("frame side-data type is unsupported")
    return rotation


def _parse_top(value: object, *, rows_field: str) -> tuple[list[Any], list[Any]]:
    top = _exact_dict(
        value,
        {rows_field, "programs", "stream_groups", "streams"},
        label="ffprobe document",
    )
    # MPEG-TS and other containers may cause ffprobe to emit program/group
    # metadata even when the fixed recipe did not request those sections.
    # _parse_json has already bounded and UTF-8-validated the entire tree; these
    # transport-only sections are deliberately ignored and grant no authority.
    _exact_list(top["programs"], label="ffprobe programs")
    _exact_list(top["stream_groups"], label="ffprobe stream groups")
    rows = _exact_list(top[rows_field], label=f"ffprobe {rows_field}")
    streams = _exact_list(top["streams"], label="ffprobe streams")
    if len(streams) != 1:
        raise ValueError("ffprobe must return exactly one selected stream record")
    return rows, streams


def parse_capture_measurement_presentation_metadata_v1(
    raw: bytes,
    *,
    selected_video_stream_index: int,
) -> ParsedPresentationMetadataV1:
    """Parse one selected stream and its presentation-ordered decoded frames."""

    selected = _require_stream_index(selected_video_stream_index)
    payload = _parse_json(
        raw,
        maximum_bytes=MAX_CAPTURE_MEASUREMENT_PRESENTATION_METADATA_BYTES,
        maximum_nodes=_MAX_PRESENTATION_JSON_NODES,
        maximum_containers=_MAX_PRESENTATION_JSON_CONTAINERS,
    )
    frames, streams = _parse_top(payload, rows_field="frames")
    if not 1 <= len(frames) <= MAX_FINALIZED_FRAMES:
        raise ValueError(
            "presentation frame count is outside its bounded finalized-segment limit"
        )
    stream = _exact_dict(
        streams[0],
        {
            "codec_name",
            "codec_type",
            "field_order",
            "height",
            "index",
            "sample_aspect_ratio",
            "time_base",
            "width",
        },
        optional={"side_data_list"},
        label="selected presentation stream",
    )
    stream_index = require_exact_int(
        stream["index"], "stream index", minimum=0, maximum=MAX_SIGNED_64
    )
    if stream_index != selected or stream["codec_type"] != "video":
        raise ValueError("selected absolute stream is not the requested video stream")
    if type(stream["codec_name"]) is not str or stream["codec_name"] not in _CODEC_MAP:
        raise ValueError("selected video codec is not accepted by V1")
    observed_codec = _CODEC_MAP[stream["codec_name"]]
    time_base = _parse_time_base(stream["time_base"])
    sample_aspect_ratio = _parse_sample_aspect_ratio(stream["sample_aspect_ratio"])
    width = require_exact_int(
        stream["width"], "stream width", minimum=1, maximum=MAX_DECODED_DIMENSION_PX
    )
    height = require_exact_int(
        stream["height"],
        "stream height",
        minimum=1,
        maximum=MAX_DECODED_DIMENSION_PX,
    )
    field_order = _require_ascii_string(
        stream["field_order"], label="field_order", maximum=16
    )
    stream_rotation = (
        _metadata_stream_rotation(stream["side_data_list"])
        if "side_data_list" in stream
        else None
    )

    timing_rows: list[PresentationTimingRowV1] = []
    interlace_facts: list[DecodedFrameInterlaceFactV1] = []
    source_pix_fmt: str | None = None
    observed_rotation = stream_rotation
    required_frame_fields = {
        "height",
        "interlaced_frame",
        "media_type",
        "pix_fmt",
        "repeat_pict",
        "sample_aspect_ratio",
        "stream_index",
        "top_field_first",
        "width",
    }
    optional_frame_fields = {
        "coded_picture_number",
        "display_picture_number",
        "duration",
        "pkt_dts",
        "pkt_pos",
        "pkt_size",
        "pts",
        "side_data_list",
    }
    for ordinal, frame_value in enumerate(frames):
        frame = _exact_dict(
            frame_value,
            required_frame_fields,
            optional=optional_frame_fields,
            label="presentation frame",
        )
        if frame["media_type"] != "video":
            raise ValueError("presentation frame has an unexpected media type")
        frame_stream = require_exact_int(
            frame["stream_index"],
            "frame stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        frame_width = require_exact_int(
            frame["width"], "frame width", minimum=1, maximum=MAX_DECODED_DIMENSION_PX
        )
        frame_height = require_exact_int(
            frame["height"],
            "frame height",
            minimum=1,
            maximum=MAX_DECODED_DIMENSION_PX,
        )
        if frame_stream != selected or frame_width != width or frame_height != height:
            raise ValueError("presentation frame stream or geometry changed")
        frame_sample_aspect_ratio = _parse_sample_aspect_ratio(
            frame["sample_aspect_ratio"]
        )
        if frame_sample_aspect_ratio != sample_aspect_ratio:
            raise ValueError("presentation frame sample aspect ratio changed")
        pix_fmt = _require_ascii_string(
            frame["pix_fmt"], label="frame pixel format", maximum=64
        )
        if _ASCII_TOKEN_RE.fullmatch(pix_fmt) is None:
            raise ValueError("frame pixel format is not a normalized token")
        if source_pix_fmt is None:
            source_pix_fmt = pix_fmt
        elif pix_fmt != source_pix_fmt:
            raise ValueError("presentation frame pixel format changed")
        interlaced = require_exact_int(
            frame["interlaced_frame"], "interlaced_frame", minimum=0, maximum=1
        )
        top_field_first = require_exact_int(
            frame["top_field_first"], "top_field_first", minimum=0, maximum=1
        )
        if not interlaced and top_field_first:
            raise ValueError("progressive frame cannot be top-field-first")
        fact = (
            DecodedFrameInterlaceFactV1.INTERLACED
            if interlaced
            else DecodedFrameInterlaceFactV1.PROGRESSIVE
        )
        if interlace_facts and fact is not interlace_facts[0]:
            raise ValueError("frame interlace fact changed within the selected stream")
        interlace_facts.append(fact)
        require_exact_int(
            frame["repeat_pict"], "repeat_pict", minimum=0, maximum=MAX_SIGNED_64
        )
        for field in ("coded_picture_number", "display_picture_number"):
            if field in frame:
                require_exact_int(frame[field], field, minimum=0, maximum=MAX_SIGNED_64)
        pts = _optional_signed_int(frame, "pts")
        _optional_signed_int(frame, "pkt_dts")
        if "duration" in frame:
            require_exact_int(
                frame["duration"], "frame duration", minimum=0, maximum=MAX_SIGNED_64
            )
        if "pkt_pos" in frame:
            _decimal_string_int(frame["pkt_pos"], label="frame pkt_pos", minimum=0)
        if "pkt_size" in frame:
            _decimal_string_int(frame["pkt_size"], label="frame pkt_size", minimum=1)
        if "side_data_list" in frame:
            frame_rotation = _frame_rotation(frame["side_data_list"])
            if frame_rotation is not None:
                if observed_rotation is None:
                    observed_rotation = frame_rotation
                elif frame_rotation != observed_rotation:
                    raise ValueError("display rotation changed or is ambiguous")
        timing_rows.append(
            PresentationTimingRowV1(
                decoded_frame_ordinal=ordinal,
                selected_video_stream_index=selected,
                presentation_pts=pts,
                source_time_base_numerator=time_base[0],
                source_time_base_denominator=time_base[1],
            )
        )

    first_fact = interlace_facts[0]
    if first_fact is DecodedFrameInterlaceFactV1.PROGRESSIVE:
        if field_order != "progressive":
            raise ValueError("stream field_order contradicts progressive frames")
    elif field_order not in _INTERLACED_FIELD_ORDERS:
        raise ValueError("stream field_order contradicts interlaced frames")
    return ParsedPresentationMetadataV1(
        observed_codec=observed_codec,
        selected_video_stream_index=selected,
        source_time_base_numerator=time_base[0],
        source_time_base_denominator=time_base[1],
        decoded_width_px=width,
        decoded_height_px=height,
        sample_aspect_ratio_numerator=sample_aspect_ratio[0],
        sample_aspect_ratio_denominator=sample_aspect_ratio[1],
        display_rotation_degrees=observed_rotation or 0,
        presentation_timing_rows=tuple(timing_rows),
        frame_interlace_facts=tuple(interlace_facts),
    )


def parse_capture_measurement_selected_video_packets_v1(
    raw: bytes,
    *,
    selected_video_stream_index: int,
) -> tuple[SelectedVideoPacketPayloadRowV1, ...]:
    """Parse selected packet payload facts independently from frame cadence."""

    selected = _require_stream_index(selected_video_stream_index)
    payload = _parse_json(
        raw,
        maximum_bytes=MAX_CAPTURE_MEASUREMENT_SELECTED_PACKET_BYTES,
        maximum_nodes=_MAX_PACKET_JSON_NODES,
        maximum_containers=_MAX_PACKET_JSON_CONTAINERS,
    )
    packets, streams = _parse_top(payload, rows_field="packets")
    if not 1 <= len(packets) <= MAX_CAPTURE_MEASUREMENT_PACKETS:
        raise ValueError(
            "selected packet count is outside its bounded finalized-segment limit"
        )
    stream = _exact_dict(
        streams[0],
        {"codec_type", "index", "time_base"},
        optional={"side_data_list"},
        label="selected packet stream",
    )
    stream_index = require_exact_int(
        stream["index"], "stream index", minimum=0, maximum=MAX_SIGNED_64
    )
    if stream_index != selected or stream["codec_type"] != "video":
        raise ValueError("packet probe did not select the requested video stream")
    _parse_time_base(stream["time_base"])

    result: list[SelectedVideoPacketPayloadRowV1] = []
    for ordinal, packet_value in enumerate(packets):
        packet = _exact_dict(
            packet_value,
            {"flags", "size", "stream_index"},
            optional={"dts", "duration", "pos", "pts", "side_data_list"},
            label="selected video packet",
        )
        packet_stream = require_exact_int(
            packet["stream_index"],
            "packet stream_index",
            minimum=0,
            maximum=MAX_SIGNED_64,
        )
        if packet_stream != selected:
            raise ValueError("packet belongs to another absolute stream")
        payload_size = _decimal_string_int(
            packet["size"], label="packet size", minimum=1
        )
        flags = _require_ascii_string(packet["flags"], label="packet flags", maximum=8)
        if re.fullmatch(r"[A-Z_]{3}", flags) is None:
            raise ValueError("packet flags do not use the canonical ffprobe grammar")
        packet_pts = _optional_signed_int(packet, "pts")
        packet_dts = _optional_signed_int(packet, "dts")
        if "duration" in packet:
            require_exact_int(
                packet["duration"],
                "packet duration",
                minimum=0,
                maximum=MAX_SIGNED_64,
            )
        if "pos" in packet:
            _decimal_string_int(packet["pos"], label="packet pos", minimum=0)
        result.append(
            SelectedVideoPacketPayloadRowV1(
                packet_ordinal=ordinal,
                selected_video_stream_index=selected,
                payload_byte_length=payload_size,
                packet_pts=packet_pts,
                packet_dts=packet_dts,
            )
        )
    return tuple(result)


def _validated_metadata(value: object) -> ParsedPresentationMetadataV1:
    if type(value) is not ParsedPresentationMetadataV1:
        raise ValueError("metadata must be exact ParsedPresentationMetadataV1")
    # Frozen dataclasses remain mutable through object.__setattr__; reconstruction
    # re-runs every exact-type, canonical-row, and false-authority invariant.
    return ParsedPresentationMetadataV1(
        observed_codec=value.observed_codec,
        selected_video_stream_index=value.selected_video_stream_index,
        source_time_base_numerator=value.source_time_base_numerator,
        source_time_base_denominator=value.source_time_base_denominator,
        decoded_width_px=value.decoded_width_px,
        decoded_height_px=value.decoded_height_px,
        sample_aspect_ratio_numerator=value.sample_aspect_ratio_numerator,
        sample_aspect_ratio_denominator=value.sample_aspect_ratio_denominator,
        display_rotation_degrees=value.display_rotation_degrees,
        presentation_timing_rows=value.presentation_timing_rows,
        frame_interlace_facts=value.frame_interlace_facts,
        admissible_for_training=value.admissible_for_training,
        admissible_for_evaluation=value.admissible_for_evaluation,
        admissible_for_test=value.admissible_for_test,
        admissible_for_deployment=value.admissible_for_deployment,
        admissible_for_live_scoring=value.admissible_for_live_scoring,
    )


def parse_capture_measurement_rgb24_framehash_v1(
    raw: bytes,
    *,
    metadata: ParsedPresentationMetadataV1,
) -> tuple[DecodedFrameContentRowV1, ...]:
    """Bind canonical RGB24 SHA-256 framehash rows to presentation metadata."""

    parsed_metadata = _validated_metadata(metadata)
    if (
        type(raw) is not bytes
        or not 1 <= len(raw) <= MAX_CAPTURE_MEASUREMENT_FRAMEHASH_BYTES
    ):
        raise ValueError("framehash output is outside its exact byte bound")
    text = raw.decode("ascii", errors="strict")
    if "\r" in text or "\x00" in text or not text.endswith("\n"):
        raise ValueError("framehash must be canonical LF-delimited ASCII")
    lines = text[:-1].split("\n")
    if len(lines) != 10 + parsed_metadata.frame_count:
        raise ValueError("framehash line or decoded-frame count is invalid")
    if tuple(lines[:3]) != _FRAMEHASH_FIXED_HEADERS:
        raise ValueError("framehash fixed V2 headers are invalid")
    if _FRAMEHASH_SOFTWARE_RE.fullmatch(lines[3]) is None:
        raise ValueError("framehash software header is invalid")
    time_base = (
        f"{parsed_metadata.source_time_base_numerator}/"
        f"{parsed_metadata.source_time_base_denominator}"
    )
    if lines[4] != f"#tb 0: {time_base}":
        raise ValueError("framehash time base differs from selected decode metadata")
    if lines[5] != "#media_type 0: video":
        raise ValueError("framehash media type is not exactly video")
    if lines[6] != "#codec_id 0: rawvideo":
        raise ValueError("framehash codec is not exactly rawvideo")
    dimensions = (
        f"{parsed_metadata.decoded_width_px}x{parsed_metadata.decoded_height_px}"
    )
    if lines[7] != f"#dimensions 0: {dimensions}":
        raise ValueError("framehash dimensions differ from selected decode metadata")
    sample_aspect_ratio = (
        f"{parsed_metadata.sample_aspect_ratio_numerator}/"
        f"{parsed_metadata.sample_aspect_ratio_denominator}"
    )
    if lines[8] != f"#sar 0: {sample_aspect_ratio}" or lines[9] != _FRAMEHASH_COLUMNS:
        raise ValueError("framehash terminal headers are invalid")
    expected_size = (
        parsed_metadata.decoded_width_px * parsed_metadata.decoded_height_px * 3
    )
    result: list[DecodedFrameContentRowV1] = []
    for ordinal, (line, timing, interlace) in enumerate(
        zip(
            lines[10:],
            parsed_metadata.presentation_timing_rows,
            parsed_metadata.frame_interlace_facts,
            strict=True,
        )
    ):
        match = _FRAMEHASH_ROW_RE.fullmatch(line)
        if match is None:
            raise ValueError("framehash row does not use the canonical V2 grammar")
        dts, pts, duration, size = (
            int(match.group(index), 10) for index in range(1, 5)
        )
        for label, item in (("dts", dts), ("pts", pts), ("duration", duration)):
            if not MIN_SIGNED_64 <= item <= MAX_SIGNED_64:
                raise ValueError(f"framehash {label} is outside signed-64")
        expected_pts = (
            timing.presentation_pts
            if timing.presentation_pts is not None
            else MIN_SIGNED_64
        )
        if pts != expected_pts:
            raise ValueError("framehash PTS differs from presentation metadata")
        if dts != pts:
            raise ValueError("rawvideo framehash DTS must equal its presentation PTS")
        if size != expected_size:
            raise ValueError("framehash RGB24 frame byte size is invalid")
        result.append(
            DecodedFrameContentRowV1(
                decoded_frame_ordinal=ordinal,
                selected_video_stream_index=(
                    parsed_metadata.selected_video_stream_index
                ),
                presentation_pts=timing.presentation_pts,
                decoded_pixel_sha256=match.group(5),
                decoded_width_px=parsed_metadata.decoded_width_px,
                decoded_height_px=parsed_metadata.decoded_height_px,
                sample_aspect_ratio_numerator=(
                    parsed_metadata.sample_aspect_ratio_numerator
                ),
                sample_aspect_ratio_denominator=(
                    parsed_metadata.sample_aspect_ratio_denominator
                ),
                display_rotation_degrees=(parsed_metadata.display_rotation_degrees),
                interlace_fact=interlace,
                source_time_base_numerator=(parsed_metadata.source_time_base_numerator),
                source_time_base_denominator=(
                    parsed_metadata.source_time_base_denominator
                ),
            )
        )
    return tuple(result)


__all__ = [
    "MAX_CAPTURE_MEASUREMENT_FRAMEHASH_BYTES",
    "MAX_CAPTURE_MEASUREMENT_PACKETS",
    "MAX_CAPTURE_MEASUREMENT_PRESENTATION_METADATA_BYTES",
    "MAX_CAPTURE_MEASUREMENT_SELECTED_PACKET_BYTES",
    "ParsedPresentationMetadataV1",
    "parse_capture_measurement_presentation_metadata_v1",
    "parse_capture_measurement_rgb24_framehash_v1",
    "parse_capture_measurement_selected_video_packets_v1",
]
