"""Pure, exact FFmpeg/ffprobe argv construction for decoder runtime V1.

This module owns only immutable command tokens.  It opens no files, executes
no process, grants no capability, and has no training/evaluation authority.
The protected loader remains solely responsible for descriptor ownership,
environment/cwd isolation, output bounds, timeouts, and process-group cleanup.
"""

from __future__ import annotations

from pathlib import Path


DECODER_COMMAND_SCHEMA_VERSION = "1.0"

PROBE_SHOW_ENTRIES_V1 = (
    "stream=index,codec_type,time_base,width,height,pix_fmt,color_space,"
    "color_range,start_pts:stream_side_data=rotation:"
    "frame=stream_index,pts,width,height,pix_fmt,color_space,color_range"
)

RGB24_FILTER_GRAPH_V1 = (
    "scale=w=iw:h=ih:in_color_matrix=bt709:out_color_matrix=bt709:"
    "in_range=tv:out_range=pc:"
    "flags=accurate_rnd+full_chroma_int+bitexact:sws_dither=none,"
    "format=pix_fmts=rgb24,split=outputs=2[raw][hash]"
)

_MAX_SIGNED_64 = (1 << 63) - 1


def _require_executable(value: object) -> Path:
    if not isinstance(value, Path) or not value.is_absolute():
        raise ValueError("decoder executable must be an absolute pathlib.Path")
    rendered = str(value)
    if not rendered or "\x00" in rendered:
        raise ValueError("decoder executable path is invalid")
    return value


def _require_descriptor(value: object, field_name: str) -> int:
    if type(value) is not int or not 0 <= value <= _MAX_SIGNED_64:
        raise ValueError(f"{field_name} must be a nonnegative signed-64 integer")
    return value


def decoder_probe_argv_v1(
    executable: Path,
    *,
    input_fd: int,
    selected_video_stream_index: int,
) -> tuple[str, ...]:
    """Return the complete exact V1 ffprobe argv, including executable."""

    selected_executable = _require_executable(executable)
    selected_input_fd = _require_descriptor(input_fd, "input_fd")
    selected_stream = _require_descriptor(
        selected_video_stream_index,
        "selected_video_stream_index",
    )
    return (
        str(selected_executable),
        "-v",
        "error",
        "-protocol_whitelist",
        "fd",
        "-fd",
        str(selected_input_fd),
        "-select_streams",
        str(selected_stream),
        "-show_frames",
        "-show_entries",
        PROBE_SHOW_ENTRIES_V1,
        "-of",
        "json",
        "fd:",
    )


def decoder_decode_argv_v1(
    executable: Path,
    *,
    input_fd: int,
    framehash_output_fd: int,
    selected_video_stream_index: int,
) -> tuple[str, ...]:
    """Return the complete exact V1 FFmpeg RGB24/framehash argv."""

    selected_executable = _require_executable(executable)
    selected_input_fd = _require_descriptor(input_fd, "input_fd")
    selected_framehash_fd = _require_descriptor(
        framehash_output_fd,
        "framehash_output_fd",
    )
    selected_stream = _require_descriptor(
        selected_video_stream_index,
        "selected_video_stream_index",
    )
    if selected_input_fd == selected_framehash_fd:
        raise ValueError("input and framehash descriptors must be distinct")
    return (
        str(selected_executable),
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
        str(selected_input_fd),
        "-i",
        "fd:",
        "-filter_complex",
        f"[0:{selected_stream}]{RGB24_FILTER_GRAPH_V1}",
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
        str(selected_framehash_fd),
        "fd:",
    )


__all__ = [
    "DECODER_COMMAND_SCHEMA_VERSION",
    "PROBE_SHOW_ENTRIES_V1",
    "RGB24_FILTER_GRAPH_V1",
    "decoder_decode_argv_v1",
    "decoder_probe_argv_v1",
]
