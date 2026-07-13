#!/usr/bin/env python3
"""Regenerate the deterministic decoder development golden.

This script is intentionally pinned to the Homebrew FFmpeg 8.1 binaries used
to create the checked-in synthetic fixture.  Those tools are development-only
fixture generators, not an approved decoder runtime.  Normal tests never run
this script or discover an ambient FFmpeg installation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = ROOT / "tests" / "fixtures"
FIXTURE_FILENAME = "deterministic_decoder_v1.mp4"
EXPECTED_FILENAME = "deterministic_decoder_v1.expected.json"

FFMPEG_SHA256 = (
    "8d97d0745b0d1d8f6296c026c426c263f509306b8f81c9ffe4e93e95890ca8be"
)
FFPROBE_SHA256 = (
    "94da026e33f8c684ab2a449d25611bb808222f7f08a7d3a6233665a63fbab47a"
)
FIXTURE_SHA256 = (
    "3dcf5b3701577c1e49b450e4325dceaae20b2c16fc524cb2f0b925136e9860c1"
)
EXPECTED_CONTRACT_SHA256 = (
    "1183c51a30a2398d06134669232c3283b253548367a38c184e51bf5e637eed11"
)
FIXTURE_SIZE_BYTES = 6_836
FFMPEG_VERSION_LINE = (
    "ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers"
)
FFPROBE_VERSION_LINE = (
    "ffprobe version 8.1 Copyright (c) 2007-2026 the FFmpeg developers"
)

SOURCE_FILTER = (
    "nullsrc=size=16x12:rate=25:duration=0.20,format=yuv420p,"
    "geq=lum='if(lt(N,2)+eq(N,4),40,if(eq(N,2),80,120)+"
    "mod(X*3+Y*5,30))':cb='if(lt(N,2)+eq(N,4),90,90+"
    "mod(X*7+Y*3,30))':cr='if(lt(N,2)+eq(N,4),150,150+"
    "mod(X*5+Y*2,30))'"
)
PTS_FILTER = (
    "settb=expr=1/1000,setpts='if(eq(N,0),101,if(eq(N,1),137,"
    "if(eq(N,2),191,if(eq(N,3),263,401))))'"
)
RGB_FILTER = (
    "scale=w=iw:h=ih:in_color_matrix=bt709:out_color_matrix=bt709:"
    "in_range=tv:out_range=pc:flags=accurate_rnd+full_chroma_int+"
    "bitexact:sws_dither=none,format=pix_fmts=rgb24"
)

EXPECTED_CONTRACT: dict[str, Any] = {
    "autorotate_negative_control": {
        "height": 16,
        "rgb24_sha256s": [
            "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827",
            "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827",
            "ae4011c1a4bf6b487778166cbcb77e9f78e697a81632718b13b00fd5343df340",
            "546e300debc062c53863d56027c374ef6c5e555be5c7cc7a535ab08ff8a352ff",
            "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827",
        ],
        "width": 12,
    },
    "demux_packets": [
        {"dts": 11, "pts": 101},
        {"dts": 47, "pts": 263},
        {"dts": 101, "pts": 137},
        {"dts": 137, "pts": 191},
        {"dts": 191, "pts": 401},
    ],
    "development_generator": {
        "ffmpeg_executable_sha256": FFMPEG_SHA256,
        "ffmpeg_version_line": FFMPEG_VERSION_LINE,
        "ffprobe_executable_sha256": FFPROBE_SHA256,
        "ffprobe_version_line": FFPROBE_VERSION_LINE,
        "production_approved": False,
    },
    "fixture": {
        "filename": FIXTURE_FILENAME,
        "sha256": FIXTURE_SHA256,
        "size_bytes": FIXTURE_SIZE_BYTES,
    },
    "pixel_equivalent_frame_index_groups": [[0, 1, 4]],
    "presentation_frames": [
        {
            "frame_index": 0,
            "framehash_duration": 36,
            "pict_type": "I",
            "pts": 101,
            "rgb24_sha256": (
                "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827"
            ),
        },
        {
            "frame_index": 1,
            "framehash_duration": 36,
            "pict_type": "B",
            "pts": 137,
            "rgb24_sha256": (
                "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827"
            ),
        },
        {
            "frame_index": 2,
            "framehash_duration": 54,
            "pict_type": "B",
            "pts": 191,
            "rgb24_sha256": (
                "a5a6f7dfe209d33573f50639c5e5de3e8f1ecdfdd7ee3394de90f144477abac3"
            ),
        },
        {
            "frame_index": 3,
            "framehash_duration": 54,
            "pict_type": "P",
            "pts": 263,
            "rgb24_sha256": (
                "012fc7378dac7415516d97682d4ee6eeef0f9878a340c6cba7f0319a21534e1b"
            ),
        },
        {
            "frame_index": 4,
            "framehash_duration": 40,
            "pict_type": "P",
            "pts": 401,
            "rgb24_sha256": (
                "31da2f6a40bd11988486b97d769672e209e7584e0e4abfc0c6066d8b6d373827"
            ),
        },
    ],
    "schema_version": "1.0",
    "selected_video": {
        "autorotation_policy": "IGNORE_CONTAINER_DISPLAY_TRANSFORM",
        "color_range": "tv",
        "color_space": "bt709",
        "decoded_frame_hash_basis": (
            "RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING"
        ),
        "frame_size_bytes": 576,
        "height": 12,
        "output_pixel_format": "rgb24",
        "rotation_degrees": 90,
        "source_pts_are_absolute": True,
        "stream_index": 2,
        "time_base_denominator": 1000,
        "time_base_numerator": 1,
        "width": 16,
    },
    "source_streams": [
        {"codec_type": "audio", "stream_index": 0},
        {
            "codec_type": "video",
            "height": 8,
            "stream_index": 1,
            "width": 8,
        },
        {
            "codec_type": "video",
            "height": 12,
            "stream_index": 2,
            "width": 16,
        },
    ],
}

_FRAMEHASH_ROW = re.compile(
    r"^(?P<stream>[0-9]+),\s*(?P<dts>-?[0-9]+),\s*"
    r"(?P<pts>-?[0-9]+),\s*(?P<duration>-?[0-9]+),\s*"
    r"(?P<size>[0-9]+),\s*(?P<sha256>[0-9a-f]{64})$"
)


def _sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _run(
    command: list[str], *, timeout: int = 30
) -> subprocess.CompletedProcess[bytes]:
    print("+", shlex.join(command))
    result = subprocess.run(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"command failed with exit {result.returncode}: "
            f"{result.stderr.decode('utf-8', 'replace')}"
        )
    return result


def _pin_tool(path: Path, *, expected_sha256: str, expected_version: str) -> str:
    observed_sha256 = _sha256_path(path)
    if observed_sha256 != expected_sha256:
        raise RuntimeError(
            f"{path} sha256 {observed_sha256} is not pinned {expected_sha256}"
        )
    result = _run([str(path), "-hide_banner", "-version"])
    lines = result.stdout.decode("utf-8", "strict").splitlines()
    if not lines or lines[0] != expected_version:
        raise RuntimeError(f"{path} version line is not pinned: {lines[:1]!r}")
    return observed_sha256


def _probe_json(ffprobe: Path, media: Path, arguments: list[str]) -> dict[str, Any]:
    result = _run(
        [str(ffprobe), "-v", "error", *arguments, "-of", "json", str(media)]
    )
    value = json.loads(result.stdout)
    if type(value) is not dict:
        raise RuntimeError("ffprobe did not return a JSON object")
    return value


def _rotation(stream: dict[str, Any]) -> int | None:
    rotations = [
        item.get("rotation")
        for item in stream.get("side_data_list", [])
        if type(item) is dict and "rotation" in item
    ]
    if len(rotations) > 1:
        raise RuntimeError("selected stream has multiple rotation values")
    return rotations[0] if rotations else None


def _verify_probe(ffprobe: Path, media: Path) -> None:
    stream_document = _probe_json(
        ffprobe,
        media,
        [
            "-show_streams",
            "-show_entries",
            (
                "stream=index,codec_type,width,height,pix_fmt,color_space,"
                "color_range,time_base,start_pts:stream_side_data=rotation"
            ),
        ],
    )
    streams = stream_document.get("streams")
    if type(streams) is not list or len(streams) != 3:
        raise RuntimeError("golden must contain exactly three global streams")
    observed_streams = [
        {"codec_type": stream.get("codec_type"), "stream_index": stream.get("index")}
        for stream in streams
    ]
    if observed_streams != [
        {"codec_type": "audio", "stream_index": 0},
        {"codec_type": "video", "stream_index": 1},
        {"codec_type": "video", "stream_index": 2},
    ]:
        raise RuntimeError(f"unexpected global stream order: {observed_streams!r}")
    if (streams[1].get("width"), streams[1].get("height")) != (8, 8):
        raise RuntimeError("auxiliary video dimensions changed")
    selected = streams[2]
    selected_fields = {
        "color_range": selected.get("color_range"),
        "color_space": selected.get("color_space"),
        "height": selected.get("height"),
        "rotation": _rotation(selected),
        "start_pts": selected.get("start_pts"),
        "time_base": selected.get("time_base"),
        "width": selected.get("width"),
    }
    expected_fields = {
        "color_range": "tv",
        "color_space": "bt709",
        "height": 12,
        "rotation": 90,
        "start_pts": 101,
        "time_base": "1/1000",
        "width": 16,
    }
    if selected_fields != expected_fields:
        raise RuntimeError(f"selected stream contract changed: {selected_fields!r}")

    frame_document = _probe_json(
        ffprobe,
        media,
        [
            "-select_streams",
            "2",
            "-show_frames",
            "-show_entries",
            (
                "frame=stream_index,pts,width,height,pix_fmt,pict_type,"
                "color_range,color_space"
            ),
        ],
    )
    frames = frame_document.get("frames")
    if type(frames) is not list:
        raise RuntimeError("ffprobe frames section is absent")
    frame_core = [
        {
            "color_range": item.get("color_range"),
            "color_space": item.get("color_space"),
            "height": item.get("height"),
            "pict_type": item.get("pict_type"),
            "pix_fmt": item.get("pix_fmt"),
            "pts": item.get("pts"),
            "stream_index": item.get("stream_index"),
            "width": item.get("width"),
        }
        for item in frames
    ]
    expected_frame_core = [
        {
            "color_range": "tv",
            "color_space": "bt709",
            "height": 12,
            "pict_type": pict_type,
            "pix_fmt": "yuv420p",
            "pts": pts,
            "stream_index": 2,
            "width": 16,
        }
        for pts, pict_type in zip(
            (101, 137, 191, 263, 401), ("I", "B", "B", "P", "P"), strict=True
        )
    ]
    if frame_core != expected_frame_core:
        raise RuntimeError(f"presentation frame contract changed: {frame_core!r}")

    packet_document = _probe_json(
        ffprobe,
        media,
        [
            "-select_streams",
            "2",
            "-show_packets",
            "-show_entries",
            "packet=stream_index,pts,dts",
        ],
    )
    packets = packet_document.get("packets")
    if type(packets) is not list:
        raise RuntimeError("ffprobe packets section is absent")
    packet_core = [
        {"dts": item.get("dts"), "pts": item.get("pts")} for item in packets
    ]
    if packet_core != EXPECTED_CONTRACT["demux_packets"]:
        raise RuntimeError(f"B-frame packet reorder changed: {packet_core!r}")


def _parse_framehash(
    payload: bytes,
) -> tuple[tuple[int, int], tuple[int, int], list[dict[str, Any]]]:
    lines = payload.decode("ascii", "strict").splitlines()
    time_base_match = next(
        (
            re.fullmatch(r"#tb 0: ([0-9]+)/([0-9]+)", line)
            for line in lines
            if line.startswith("#tb 0:")
        ),
        None,
    )
    dimensions_match = next(
        (
            re.fullmatch(r"#dimensions 0: ([0-9]+)x([0-9]+)", line)
            for line in lines
            if line.startswith("#dimensions 0:")
        ),
        None,
    )
    if time_base_match is None or dimensions_match is None:
        raise RuntimeError("framehash header is incomplete")
    if "#hash: SHA256" not in lines or "#codec_id 0: rawvideo" not in lines:
        raise RuntimeError("framehash algorithm or codec changed")
    rows: list[dict[str, Any]] = []
    for line in lines:
        if not line.startswith("0,"):
            continue
        match = _FRAMEHASH_ROW.fullmatch(line)
        if match is None:
            raise RuntimeError(f"malformed framehash row: {line!r}")
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
        (int(time_base_match.group(1)), int(time_base_match.group(2))),
        (int(dimensions_match.group(1)), int(dimensions_match.group(2))),
        rows,
    )


def _decode_rgb_and_framehash(
    ffmpeg: Path,
    media: Path,
    *,
    autorotate: bool,
    stream_index: int = 2,
) -> tuple[bytes, bytes]:
    hash_read, hash_write = os.pipe()
    rotation_option = "-autorotate" if autorotate else "-noautorotate"
    command = [
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
        rotation_option,
        "-i",
        str(media),
        "-filter_complex",
        f"[0:{stream_index}]{RGB_FILTER},split=outputs=2[raw][hash]",
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
        "-fd",
        str(hash_write),
        "fd:",
    ]
    print("+", shlex.join(command))
    try:
        process = subprocess.Popen(
            command,
            pass_fds=(hash_write,),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except BaseException:
        os.close(hash_read)
        os.close(hash_write)
        raise
    os.close(hash_write)
    framehash_chunks: list[bytes] = []

    def drain_framehash() -> None:
        while True:
            chunk = os.read(hash_read, 1 << 16)
            if not chunk:
                return
            framehash_chunks.append(chunk)

    reader = threading.Thread(target=drain_framehash, daemon=True)
    reader.start()
    try:
        try:
            rgb, stderr = process.communicate(timeout=30)
        except subprocess.TimeoutExpired as error:
            process.kill()
            process.communicate()
            raise RuntimeError("decoder golden validation timed out") from error
    finally:
        reader.join(timeout=5)
        os.close(hash_read)
    if reader.is_alive():
        raise RuntimeError("framehash reader did not reach EOF")
    if process.returncode != 0:
        raise RuntimeError(
            f"decoder golden validation failed with exit {process.returncode}: "
            f"{stderr.decode('utf-8', 'replace')}"
        )
    return rgb, b"".join(framehash_chunks)


def _verify_decode(ffmpeg: Path, media: Path) -> None:
    expected_frames = EXPECTED_CONTRACT["presentation_frames"]
    expected_pts = [item["pts"] for item in expected_frames]
    expected_hashes = [item["rgb24_sha256"] for item in expected_frames]
    expected_durations = [item["framehash_duration"] for item in expected_frames]

    rgb, framehash = _decode_rgb_and_framehash(ffmpeg, media, autorotate=False)
    time_base, dimensions, rows = _parse_framehash(framehash)
    if time_base != (1, 1000) or dimensions != (16, 12):
        raise RuntimeError("source-grid decode time base or dimensions changed")
    if [row["pts"] for row in rows] != expected_pts:
        raise RuntimeError("source-grid decode rebased or changed PTS")
    if [row["duration"] for row in rows] != expected_durations:
        raise RuntimeError("source-grid framehash durations changed")
    if any(row["stream"] != 0 or row["dts"] != row["pts"] for row in rows):
        raise RuntimeError("framehash output-local stream/DTS contract changed")
    if any(row["size"] != 576 for row in rows):
        raise RuntimeError("source-grid RGB24 frame size changed")
    if [row["sha256"] for row in rows] != expected_hashes:
        raise RuntimeError("source-grid framehash payload hashes changed")
    if len(rgb) != 5 * 576:
        raise RuntimeError("source-grid raw RGB byte count changed")
    independent_hashes = [
        hashlib.sha256(rgb[offset : offset + 576]).hexdigest()
        for offset in range(0, len(rgb), 576)
    ]
    if independent_hashes != expected_hashes:
        raise RuntimeError("framehash does not match independent RGB24 hashes")

    rotated_rgb, rotated_framehash = _decode_rgb_and_framehash(
        ffmpeg, media, autorotate=True
    )
    rotated_time_base, rotated_dimensions, rotated_rows = _parse_framehash(
        rotated_framehash
    )
    negative_control = EXPECTED_CONTRACT["autorotate_negative_control"]
    if rotated_time_base != (1, 1000) or rotated_dimensions != (
        negative_control["width"],
        negative_control["height"],
    ):
        raise RuntimeError("autorotate negative-control geometry changed")
    if [row["pts"] for row in rotated_rows] != expected_pts:
        raise RuntimeError("autorotate negative control changed PTS")
    rotated_hashes = negative_control["rgb24_sha256s"]
    if [row["sha256"] for row in rotated_rows] != rotated_hashes:
        raise RuntimeError("autorotate negative-control hashes changed")
    if len(rotated_rgb) != 5 * 576:
        raise RuntimeError("autorotate negative-control byte count changed")
    independent_rotated_hashes = [
        hashlib.sha256(rotated_rgb[offset : offset + 576]).hexdigest()
        for offset in range(0, len(rotated_rgb), 576)
    ]
    if independent_rotated_hashes != rotated_hashes:
        raise RuntimeError("rotated framehash does not match RGB24 payloads")


def _generate(ffmpeg: Path, ffprobe: Path, output_directory: Path) -> None:
    ffmpeg_sha256 = _pin_tool(
        ffmpeg,
        expected_sha256=FFMPEG_SHA256,
        expected_version=FFMPEG_VERSION_LINE,
    )
    ffprobe_sha256 = _pin_tool(
        ffprobe,
        expected_sha256=FFPROBE_SHA256,
        expected_version=FFPROBE_VERSION_LINE,
    )
    print(
        json.dumps(
            {
                "development_only": True,
                "ffmpeg_executable_sha256": ffmpeg_sha256,
                "ffprobe_executable_sha256": ffprobe_sha256,
            },
            sort_keys=True,
        )
    )

    with tempfile.TemporaryDirectory(prefix="decoder-golden-") as temporary:
        temporary_directory = Path(temporary)
        target = temporary_directory / "target.mp4"
        auxiliary = temporary_directory / "aux.mp4"
        media = temporary_directory / FIXTURE_FILENAME

        _run(
            [
                str(ffmpeg),
                "-hide_banner",
                "-loglevel",
                "error",
                "-bitexact",
                "-f",
                "lavfi",
                "-i",
                SOURCE_FILTER,
                "-vf",
                PTS_FILTER,
                "-frames:v",
                "5",
                "-fps_mode",
                "passthrough",
                "-enc_time_base",
                "1:1000",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-bf",
                "2",
                "-x264-params",
                "b-adapt=0:keyint=99:min-keyint=99:scenecut=0:threads=1",
                "-color_range",
                "tv",
                "-colorspace",
                "bt709",
                "-color_primaries",
                "bt709",
                "-color_trc",
                "bt709",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-video_track_timescale",
                "1000",
                str(target),
            ]
        )
        _run(
            [
                str(ffmpeg),
                "-hide_banner",
                "-loglevel",
                "error",
                "-bitexact",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:size=8x8:rate=10:duration=0.6",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=8000:duration=0.6",
                "-map",
                "1:a:0",
                "-map",
                "0:v:0",
                "-c:a",
                "aac",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-x264-params",
                "threads=1:keyint=20:min-keyint=20:scenecut=0",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-video_track_timescale",
                "1000",
                str(auxiliary),
            ]
        )
        _run(
            [
                str(ffmpeg),
                "-hide_banner",
                "-loglevel",
                "error",
                "-bitexact",
                "-copyts",
                "-noautorotate",
                "-display_rotation",
                "90",
                "-i",
                str(target),
                "-i",
                str(auxiliary),
                "-map",
                "1:a:0",
                "-map",
                "1:v:0",
                "-map",
                "0:v:0",
                "-c",
                "copy",
                "-map_metadata",
                "-1",
                "-map_chapters",
                "-1",
                "-video_track_timescale",
                "1000",
                "-movflags",
                "+faststart",
                str(media),
            ]
        )

        observed_sha256 = _sha256_path(media)
        observed_size = media.stat().st_size
        if observed_sha256 != FIXTURE_SHA256:
            raise RuntimeError(
                f"generated fixture sha256 {observed_sha256} is not pinned "
                f"{FIXTURE_SHA256}; refusing to update checked-in artifacts"
            )
        if observed_size != FIXTURE_SIZE_BYTES:
            raise RuntimeError(
                f"generated fixture size {observed_size} is not pinned "
                f"{FIXTURE_SIZE_BYTES}"
            )

        _verify_probe(ffprobe, media)
        _verify_decode(ffmpeg, media)

        expected_bytes = (
            json.dumps(
                EXPECTED_CONTRACT,
                ensure_ascii=True,
                indent=2,
                sort_keys=True,
            )
            + "\n"
        ).encode("ascii")
        observed_expected_sha256 = hashlib.sha256(expected_bytes).hexdigest()
        if observed_expected_sha256 != EXPECTED_CONTRACT_SHA256:
            raise RuntimeError(
                "golden expected-contract sha256 "
                f"{observed_expected_sha256} is not pinned "
                f"{EXPECTED_CONTRACT_SHA256}; refusing to update artifacts"
            )

        output_directory.mkdir(parents=True, exist_ok=True)
        fixture_destination = output_directory / FIXTURE_FILENAME
        expected_destination = output_directory / EXPECTED_FILENAME
        temporary_fixture = output_directory / f".{FIXTURE_FILENAME}.tmp"
        temporary_expected = output_directory / f".{EXPECTED_FILENAME}.tmp"
        shutil.copyfile(media, temporary_fixture)
        temporary_expected.write_bytes(expected_bytes)
        os.replace(temporary_fixture, fixture_destination)
        os.replace(temporary_expected, expected_destination)
        print(f"wrote {fixture_destination}")
        print(f"wrote {expected_destination}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ffmpeg",
        type=Path,
        default=Path("/opt/homebrew/bin/ffmpeg"),
    )
    parser.add_argument(
        "--ffprobe",
        type=Path,
        default=Path("/opt/homebrew/bin/ffprobe"),
    )
    parser.add_argument(
        "--output-directory",
        type=Path,
        default=FIXTURE_DIRECTORY,
    )
    arguments = parser.parse_args()
    _generate(
        arguments.ffmpeg.resolve(strict=True),
        arguments.ffprobe.resolve(strict=True),
        arguments.output_directory.resolve(),
    )


if __name__ == "__main__":
    main()
