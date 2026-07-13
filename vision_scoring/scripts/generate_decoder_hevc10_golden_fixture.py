#!/usr/bin/env python3
"""Regenerate the development-only HEVC 10-bit decoder golden.

The generator is intentionally separate from the production runtime.  It uses
the exact pinned Homebrew FFmpeg development tool from the H.264 golden script
and refuses to update either checked-in artifact unless every source, decode,
and canonical-oracle hash remains equal to its fixed V1 pin.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any

import generate_decoder_golden_fixture as base


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_DIRECTORY = ROOT / "tests" / "fixtures"
FIXTURE_FILENAME = "deterministic_decoder_hevc10_v1.mp4"
EXPECTED_FILENAME = "deterministic_decoder_hevc10_v1.expected.json"
FIXTURE_SHA256 = (
    "380fc82506dc596f572e5535c99713ee676f7c37e5682506e994d93df1cd3aa0"
)
FIXTURE_SIZE_BYTES = 2_218
EXPECTED_CONTRACT_SHA256 = (
    "d7faaa382018313c5c49f3e02d53915b389f53dc6a026fecdaef02929ea31fa7"
)

SOURCE_FILTER = "testsrc2=size=64x64:rate=25:duration=0.20,format=yuv420p10le"
PTS_FILTER = (
    "settb=expr=1/1000,setpts='if(eq(N,0),103,if(eq(N,1),149,"
    "if(eq(N,2),211,if(eq(N,3),307,467))))'"
)
X265_PARAMETERS = (
    "pools=none:frame-threads=1:wpp=0:keyint=99:min-keyint=99:scenecut=0:"
    "bframes=2:b-adapt=0:repeat-headers=0:aud=0:hash=0:info=0"
)

EXPECTED_CONTRACT: dict[str, Any] = {
    "demux_packets": [
        {"dts": -5, "pts": 103, "size": 832},
        {"dts": 41, "pts": 307, "size": 155},
        {"dts": 103, "pts": 211, "size": 42},
        {"dts": 149, "pts": 149, "size": 33},
        {"dts": 211, "pts": 467, "size": 86},
    ],
    "development_generator": {
        "compressed_encoder": "libx265",
        "decoder_acceptance_requires_external_encoder": False,
        "ffmpeg_executable_sha256": base.FFMPEG_SHA256,
        "ffmpeg_version_line": base.FFMPEG_VERSION_LINE,
        "ffprobe_executable_sha256": base.FFPROBE_SHA256,
        "ffprobe_version_line": base.FFPROBE_VERSION_LINE,
        "license_reviewed_for_production": False,
        "production_approved": False,
    },
    "domain": "multicourt-vision-scoring:decoder-hevc10-golden:v1",
    "fixture": {
        "filename": FIXTURE_FILENAME,
        "sha256": FIXTURE_SHA256,
        "size_bytes": FIXTURE_SIZE_BYTES,
    },
    "presentation_frames": [
        {
            "frame_index": 0,
            "framehash_duration": 46,
            "pict_type": "I",
            "pts": 103,
            "rgb24_sha256": (
                "71bff9fe79095408edb8b260e7d65e251748b7d47ee85e412ead975c5cb8c6cc"
            ),
        },
        {
            "frame_index": 1,
            "framehash_duration": 62,
            "pict_type": "B",
            "pts": 149,
            "rgb24_sha256": (
                "5b75168d530d505fbe6ef8d5776c3dbc1a2218e4c0126822f131426f4e698d7a"
            ),
        },
        {
            "frame_index": 2,
            "framehash_duration": 46,
            "pict_type": "B",
            "pts": 211,
            "rgb24_sha256": (
                "22d3dc625eee41de41012022a58da9ffb681c1c7169bbe8c030212daa7200548"
            ),
        },
        {
            "frame_index": 3,
            "framehash_duration": 62,
            "pict_type": "P",
            "pts": 307,
            "rgb24_sha256": (
                "4be7e8fb77624bf11331de3ed14227c79c408295a6bb763fb2cd6e842d38b9d9"
            ),
        },
        {
            "frame_index": 4,
            "framehash_duration": 40,
            "pict_type": "P",
            "pts": 467,
            "rgb24_sha256": (
                "8bb65cf7369053815b5e67394f25c63359e291e3469deec5f889c4078690f653"
            ),
        },
    ],
    "schema_version": "1.0",
    "selected_video": {
        "codec_name": "hevc",
        "codec_tag": "hvc1",
        "color_range": "tv",
        "color_space": "bt709",
        "decoded_frame_hash_basis": (
            "RGB24_SOURCE_DIMENSIONS_ROW_MAJOR_NO_PADDING"
        ),
        "frame_size_bytes": 12_288,
        "height": 64,
        "output_pixel_format": "rgb24",
        "source_pixel_format": "yuv420p10le",
        "source_pts_are_absolute": True,
        "stream_index": 0,
        "time_base_denominator": 1000,
        "time_base_numerator": 1,
        "width": 64,
    },
}


def _canonical_expected_bytes() -> bytes:
    return (
        json.dumps(
            EXPECTED_CONTRACT,
            ensure_ascii=True,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode("ascii")


def _verify_probe(ffprobe: Path, media: Path) -> None:
    document = base._probe_json(
        ffprobe,
        media,
        [
            "-select_streams",
            "0",
            "-show_streams",
            "-show_frames",
            "-show_entries",
            (
                "stream=index,codec_name,codec_tag_string,time_base,width,height,"
                "pix_fmt,color_space,color_range,start_pts:"
                "frame=stream_index,pts,pict_type,width,height,pix_fmt,color_space,"
                "color_range"
            ),
        ],
    )
    streams = document.get("streams")
    frames = document.get("frames")
    if type(streams) is not list or len(streams) != 1:
        raise RuntimeError("HEVC golden must contain exactly one selected stream")
    stream = streams[0]
    observed_stream = {
        "codec_name": stream.get("codec_name"),
        "codec_tag": stream.get("codec_tag_string"),
        "color_range": stream.get("color_range"),
        "color_space": stream.get("color_space"),
        "height": stream.get("height"),
        "pix_fmt": stream.get("pix_fmt"),
        "start_pts": stream.get("start_pts"),
        "stream_index": stream.get("index"),
        "time_base": stream.get("time_base"),
        "width": stream.get("width"),
    }
    expected_stream = {
        "codec_name": "hevc",
        "codec_tag": "hvc1",
        "color_range": "tv",
        "color_space": "bt709",
        "height": 64,
        "pix_fmt": "yuv420p10le",
        "start_pts": 103,
        "stream_index": 0,
        "time_base": "1/1000",
        "width": 64,
    }
    if observed_stream != expected_stream:
        raise RuntimeError(f"HEVC stream contract changed: {observed_stream!r}")
    if type(frames) is not list or len(frames) != 5:
        raise RuntimeError("HEVC golden presentation frame count changed")
    expected_frames = EXPECTED_CONTRACT["presentation_frames"]
    observed_frames = [
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
            "color_range": "tv",
            "color_space": "bt709",
            "height": 64,
            "pict_type": frame["pict_type"],
            "pix_fmt": "yuv420p10le",
            "pts": frame["pts"],
            "stream_index": 0,
            "width": 64,
        }
        for frame in expected_frames
    ]
    if observed_frames != expected_frame_core:
        raise RuntimeError("HEVC presentation frame contract changed")
    packet_document = base._probe_json(
        ffprobe,
        media,
        [
            "-select_streams",
            "0",
            "-show_packets",
            "-show_entries",
            "packet=pts,dts,size",
        ],
    )
    packets = packet_document.get("packets")
    if type(packets) is not list:
        raise RuntimeError("HEVC demux packet section is absent")
    observed_packets = [
        {
            "dts": packet.get("dts"),
            "pts": packet.get("pts"),
            "size": int(packet.get("size", "-1")),
        }
        for packet in packets
    ]
    if observed_packets != EXPECTED_CONTRACT["demux_packets"]:
        raise RuntimeError("HEVC B-frame packet reorder changed")


def _verify_decode(ffmpeg: Path, media: Path) -> None:
    rgb, framehash = base._decode_rgb_and_framehash(
        ffmpeg,
        media,
        autorotate=False,
        stream_index=0,
    )
    time_base, dimensions, rows = base._parse_framehash(framehash)
    expected_frames = EXPECTED_CONTRACT["presentation_frames"]
    if time_base != (1, 1000) or dimensions != (64, 64):
        raise RuntimeError("HEVC decoded geometry or time base changed")
    if [row["pts"] for row in rows] != [row["pts"] for row in expected_frames]:
        raise RuntimeError("HEVC decoded PTS changed or rebased")
    if [row["duration"] for row in rows] != [
        row["framehash_duration"] for row in expected_frames
    ]:
        raise RuntimeError("HEVC framehash duration oracle changed")
    if any(row["stream"] != 0 or row["dts"] != row["pts"] for row in rows):
        raise RuntimeError("HEVC framehash output-local timing changed")
    if any(row["size"] != 12_288 for row in rows):
        raise RuntimeError("HEVC RGB24 frame size changed")
    expected_hashes = [row["rgb24_sha256"] for row in expected_frames]
    if [row["sha256"] for row in rows] != expected_hashes:
        raise RuntimeError("HEVC decoded framehash changed")
    if len(rgb) != 5 * 12_288:
        raise RuntimeError("HEVC decoded RGB24 byte count changed")
    observed_hashes = [
        hashlib.sha256(rgb[offset : offset + 12_288]).hexdigest()
        for offset in range(0, len(rgb), 12_288)
    ]
    if observed_hashes != expected_hashes:
        raise RuntimeError("HEVC framehash differs from independent RGB24 bytes")


def _generate(ffmpeg: Path, ffprobe: Path, output_directory: Path) -> None:
    base._pin_tool(
        ffmpeg,
        expected_sha256=base.FFMPEG_SHA256,
        expected_version=base.FFMPEG_VERSION_LINE,
    )
    base._pin_tool(
        ffprobe,
        expected_sha256=base.FFPROBE_SHA256,
        expected_version=base.FFPROBE_VERSION_LINE,
    )
    expected_bytes = _canonical_expected_bytes()
    expected_sha256 = hashlib.sha256(expected_bytes).hexdigest()
    if expected_sha256 != EXPECTED_CONTRACT_SHA256:
        raise RuntimeError(
            f"HEVC expected-contract sha256 {expected_sha256} is not pinned "
            f"{EXPECTED_CONTRACT_SHA256}; refusing to update artifacts"
        )

    with tempfile.TemporaryDirectory(prefix="decoder-hevc10-golden-") as temporary:
        media = Path(temporary) / FIXTURE_FILENAME
        base._run(
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
                "libx265",
                "-pix_fmt",
                "yuv420p10le",
                "-tag:v",
                "hvc1",
                "-bf",
                "2",
                "-x265-params",
                X265_PARAMETERS,
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
                str(media),
            ]
        )
        if media.stat().st_size != FIXTURE_SIZE_BYTES:
            raise RuntimeError("generated HEVC fixture size changed")
        observed_sha256 = base._sha256_path(media)
        if observed_sha256 != FIXTURE_SHA256:
            raise RuntimeError(
                f"generated HEVC fixture sha256 {observed_sha256} is not pinned "
                f"{FIXTURE_SHA256}; refusing to update artifacts"
            )
        _verify_probe(ffprobe, media)
        _verify_decode(ffmpeg, media)

        output_directory.mkdir(parents=True, exist_ok=True)
        fixture_destination = output_directory / FIXTURE_FILENAME
        expected_destination = output_directory / EXPECTED_FILENAME
        temporary_fixture = output_directory / f".{FIXTURE_FILENAME}.tmp"
        temporary_expected = output_directory / f".{EXPECTED_FILENAME}.tmp"
        shutil.copyfile(media, temporary_fixture)
        temporary_expected.write_bytes(expected_bytes)
        os.replace(temporary_fixture, fixture_destination)
        os.replace(temporary_expected, expected_destination)


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
