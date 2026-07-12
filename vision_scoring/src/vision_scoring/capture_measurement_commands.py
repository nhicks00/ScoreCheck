"""Pure, exact argv construction for full-stream capture measurement.

This module constructs immutable command tokens only.  It opens no path,
descriptor, or network protocol; executes no process; invokes no shell; and
grants no training, readiness, deployment, or scoring authority.  A protected
executor must supply pinned executables and preopened descriptors, isolate the
process environment, strictly bound captured ffprobe stdout and auxiliary
FFmpeg output, parse every row, and verify the selected
absolute demux-stream index is video before relying on a later receipt.

Decoded presentation-frame PTS is the only cadence input.  Packet PTS/DTS and
frame packet-DTS are collected as separate diagnostics for B-frame/reordering
analysis and must never be substituted for presentation cadence.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from .contract_wire import MAX_SIGNED_64, canonical_json_bytes
from .decoder_commands import RGB24_FILTER_GRAPH_V1


CAPTURE_MEASUREMENT_COMMAND_SCHEMA_VERSION = "1.0"
CAPTURE_MEASUREMENT_RECIPE_DOMAIN = (
    "multicourt-vision-scoring:capture-measurement-command-recipe:v1"
)
MAX_CAPTURE_MEASUREMENT_RECIPE_BYTES = 64 * 1024

PRESENTATION_METADATA_SHOW_ENTRIES_V1 = (
    "stream=index,codec_name,codec_type,time_base,width,height,field_order:"
    "stream_side_data=rotation:"
    "frame=media_type,stream_index,pts,pkt_dts,duration,pkt_pos,pkt_size,"
    "width,height,pix_fmt,interlaced_frame,top_field_first,repeat_pict,"
    "coded_picture_number,display_picture_number"
)
SELECTED_VIDEO_PACKET_SHOW_ENTRIES_V1 = (
    "stream=index,codec_type,time_base:"
    "packet=stream_index,pts,dts,duration,pos,size,flags"
)
FFPROBE_JSON_OUTPUT_FORMAT_V1 = "json=compact=1"

_DECODER_SPLIT_SUFFIX = ",split=outputs=2[raw][hash]"
if not RGB24_FILTER_GRAPH_V1.endswith(_DECODER_SPLIT_SUFFIX):
    raise RuntimeError("decoder RGB24 filter graph no longer has its fixed V1 split")
MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1 = (
    RGB24_FILTER_GRAPH_V1[: -len(_DECODER_SPLIT_SUFFIX)] + "[hash]"
)

_EXACT_PATH_TYPE = type(Path("/"))


def _require_executable(value: object, field_name: str) -> Path:
    if type(value) is not _EXACT_PATH_TYPE or not value.is_absolute():
        raise ValueError(f"{field_name} must be an exact absolute pathlib.Path")
    rendered = str(value)
    if not rendered or "\x00" in rendered:
        raise ValueError(f"{field_name} path is invalid")
    return value


def _require_preopened_fd(value: object, field_name: str) -> int:
    if type(value) is not int or not 3 <= value <= MAX_SIGNED_64:
        raise ValueError(
            f"{field_name} must be a preopened signed-64 descriptor in [3, "
            f"{MAX_SIGNED_64}]"
        )
    return value


def _require_stream_index(value: object) -> int:
    if type(value) is not int or not 0 <= value <= MAX_SIGNED_64:
        raise ValueError(
            "selected_video_stream_index must be a nonnegative signed-64 integer"
        )
    return value


def _validated_command_coordinates(
    executable: object,
    *,
    executable_field_name: str,
    input_fd: object,
    output_fd: object,
    output_fd_field_name: str,
    selected_video_stream_index: object,
) -> tuple[str, str, str, str]:
    selected_executable = _require_executable(executable, executable_field_name)
    selected_input_fd = _require_preopened_fd(input_fd, "input_fd")
    selected_output_fd = _require_preopened_fd(output_fd, output_fd_field_name)
    selected_stream = _require_stream_index(selected_video_stream_index)
    if selected_input_fd == selected_output_fd:
        raise ValueError("input and output descriptors must be distinct")
    return (
        str(selected_executable),
        str(selected_input_fd),
        str(selected_output_fd),
        str(selected_stream),
    )


def _validated_probe_coordinates(
    executable: object,
    *,
    input_fd: object,
    selected_video_stream_index: object,
) -> tuple[str, str, str]:
    selected_executable = _require_executable(executable, "ffprobe_executable")
    selected_input_fd = _require_preopened_fd(input_fd, "input_fd")
    selected_stream = _require_stream_index(selected_video_stream_index)
    return str(selected_executable), str(selected_input_fd), str(selected_stream)


def _presentation_metadata_tokens_v1(
    executable: str,
    input_fd: str,
    selected_stream: str,
) -> tuple[str, ...]:
    return (
        executable,
        "-v",
        "error",
        "-bitexact",
        "-protocol_whitelist",
        "fd",
        "-fd",
        input_fd,
        "-i",
        "fd:",
        "-select_streams",
        selected_stream,
        "-show_streams",
        "-show_frames",
        "-show_entries",
        PRESENTATION_METADATA_SHOW_ENTRIES_V1,
        "-of",
        FFPROBE_JSON_OUTPUT_FORMAT_V1,
    )


def capture_measurement_presentation_metadata_argv_v1(
    ffprobe_executable: Path,
    *,
    input_fd: int,
    selected_video_stream_index: int,
) -> tuple[str, ...]:
    """Build exact metadata/frame probe argv; JSON is bounded runner stdout."""

    executable, input_value, stream = _validated_probe_coordinates(
        ffprobe_executable,
        input_fd=input_fd,
        selected_video_stream_index=selected_video_stream_index,
    )
    return _presentation_metadata_tokens_v1(executable, input_value, stream)


def _selected_video_packet_tokens_v1(
    executable: str,
    input_fd: str,
    selected_stream: str,
) -> tuple[str, ...]:
    return (
        executable,
        "-v",
        "error",
        "-bitexact",
        "-protocol_whitelist",
        "fd",
        "-fd",
        input_fd,
        "-i",
        "fd:",
        "-select_streams",
        selected_stream,
        "-show_streams",
        "-show_packets",
        "-show_entries",
        SELECTED_VIDEO_PACKET_SHOW_ENTRIES_V1,
        "-of",
        FFPROBE_JSON_OUTPUT_FORMAT_V1,
    )


def capture_measurement_selected_video_packets_argv_v1(
    ffprobe_executable: Path,
    *,
    input_fd: int,
    selected_video_stream_index: int,
) -> tuple[str, ...]:
    """Build exact packet probe argv; JSON is bounded runner stdout."""

    executable, input_value, stream = _validated_probe_coordinates(
        ffprobe_executable,
        input_fd=input_fd,
        selected_video_stream_index=selected_video_stream_index,
    )
    return _selected_video_packet_tokens_v1(executable, input_value, stream)


def _rgb24_framehash_tokens_v1(
    executable: str,
    input_fd: str,
    output_fd: str,
    selected_stream: str,
) -> tuple[str, ...]:
    return (
        executable,
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
        f"[0:{selected_stream}]{MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1}",
        "-map",
        "[hash]",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
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
        output_fd,
        "fd:",
    )


def capture_measurement_rgb24_framehash_argv_v1(
    ffmpeg_executable: Path,
    *,
    input_fd: int,
    framehash_output_fd: int,
    selected_video_stream_index: int,
) -> tuple[str, ...]:
    """Build exact bitexact RGB24 full-frame SHA-256/geometry argv."""

    executable, input_value, output_value, stream = _validated_command_coordinates(
        ffmpeg_executable,
        executable_field_name="ffmpeg_executable",
        input_fd=input_fd,
        output_fd=framehash_output_fd,
        output_fd_field_name="framehash_output_fd",
        selected_video_stream_index=selected_video_stream_index,
    )
    return _rgb24_framehash_tokens_v1(
        executable, input_value, output_value, stream
    )


def capture_measurement_recipe_descriptor_v1() -> dict[str, Any]:
    """Return a fresh JSON-safe descriptor of every fixed argv semantic."""

    return {
        "decoded_frame_content": (
            "SHA256_OF_BITEXACT_NOAUTOROTATE_BT709_LIMITED_TO_RGB24_FRAME_BYTES"
        ),
        "domain": CAPTURE_MEASUREMENT_RECIPE_DOMAIN,
        "frame_ordinal": "ZERO_BASED_PRESENTATION_FRAMES_JSON_ARRAY_ORDER",
        "framehash_output_transport": "PREOPENED_FD_GE_3",
        "framehash_argv_template": list(
            _rgb24_framehash_tokens_v1(
                "{FFMPEG_EXECUTABLE}",
                "{INPUT_FD}",
                "{FRAMEHASH_OUTPUT_FD}",
                "{SELECTED_VIDEO_STREAM_INDEX}",
            )
        ),
        "metadata_argv_template": list(
            _presentation_metadata_tokens_v1(
                "{FFPROBE_EXECUTABLE}",
                "{INPUT_FD}",
                "{SELECTED_VIDEO_STREAM_INDEX}",
            )
        ),
        "packet_argv_template": list(
            _selected_video_packet_tokens_v1(
                "{FFPROBE_EXECUTABLE}",
                "{INPUT_FD}",
                "{SELECTED_VIDEO_STREAM_INDEX}",
            )
        ),
        "packet_timing_role": "DIAGNOSTIC_ONLY_NOT_PRESENTATION_CADENCE",
        "presentation_cadence_basis": "FRAME_PTS_IN_JSON_ARRAY_ORDER_ONLY",
        "probe_output_transport": "PROTECTED_RUNNER_BOUNDED_STDOUT",
        "schema_version": CAPTURE_MEASUREMENT_COMMAND_SCHEMA_VERSION,
        "selected_stream_mapping": "ABSOLUTE_DEMUX_STREAM_INDEX",
    }


def capture_measurement_recipe_sha256_v1() -> str:
    """Fingerprint the fixed recipe; any token/semantic change changes it."""

    return hashlib.sha256(
        canonical_json_bytes(
            capture_measurement_recipe_descriptor_v1(),
            label="capture measurement command recipe",
            maximum_bytes=MAX_CAPTURE_MEASUREMENT_RECIPE_BYTES,
        )
    ).hexdigest()


CAPTURE_MEASUREMENT_RECIPE_SHA256_V1 = capture_measurement_recipe_sha256_v1()


__all__ = [
    "CAPTURE_MEASUREMENT_COMMAND_SCHEMA_VERSION",
    "CAPTURE_MEASUREMENT_RECIPE_DOMAIN",
    "CAPTURE_MEASUREMENT_RECIPE_SHA256_V1",
    "FFPROBE_JSON_OUTPUT_FORMAT_V1",
    "MEASUREMENT_RGB24_FRAMEHASH_FILTER_GRAPH_V1",
    "PRESENTATION_METADATA_SHOW_ENTRIES_V1",
    "SELECTED_VIDEO_PACKET_SHOW_ENTRIES_V1",
    "capture_measurement_presentation_metadata_argv_v1",
    "capture_measurement_recipe_descriptor_v1",
    "capture_measurement_recipe_sha256_v1",
    "capture_measurement_rgb24_framehash_argv_v1",
    "capture_measurement_selected_video_packets_argv_v1",
]
