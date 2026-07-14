"""CLI: turn a produced VOD with a ScoreCheck scorebug into score labels.

Pipeline: probe frames -> locate scorebug -> stream cropped frames at
``--fps`` via one ffmpeg rawvideo pipe -> OCR each crop (Apple Vision) ->
parse readings -> volleyball-legal timeline -> events/states/rallies/summary
under ``--out``.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from .scorebug import BugRect, locate_scorebug, parse_scorebug
from .score_timeline import ScoreTimeline, write_outputs


def probe_duration_seconds(source: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(source),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    return float(json.loads(result.stdout)["format"]["duration"])


def extract_frame(source: Path, t_seconds: float) -> np.ndarray | None:
    """Decode one full RGB frame at ``t_seconds``."""
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{t_seconds:.3f}",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-",
        ],
        capture_output=True,
        timeout=120,
    )
    if result.returncode != 0 or not result.stdout:
        return None
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            str(source),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    dims = json.loads(probe.stdout)["streams"][0]
    width, height = int(dims["width"]), int(dims["height"])
    frame = np.frombuffer(result.stdout, dtype=np.uint8)
    if frame.size != width * height * 3:
        return None
    return frame.reshape(height, width, 3)


def stream_crops(
    source: Path,
    rect: BugRect,
    *,
    fps: float,
    start_seconds: float,
    max_seconds: float | None,
):
    """Yield (t_seconds, crop RGB ndarray) via a single ffmpeg pipe."""
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{start_seconds:.3f}",
        "-i",
        str(source),
    ]
    if max_seconds is not None:
        cmd += ["-t", f"{max_seconds:.3f}"]
    cmd += [
        "-vf",
        f"fps={fps},crop={rect.width}:{rect.height}:{rect.x}:{rect.y}",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
    ]
    frame_bytes = rect.width * rect.height * 3
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    assert proc.stdout is not None
    index = 0
    try:
        while True:
            chunk = proc.stdout.read(frame_bytes)
            if chunk is None or len(chunk) < frame_bytes:
                break
            crop = np.frombuffer(chunk, dtype=np.uint8).reshape(
                rect.height, rect.width, 3
            )
            yield start_seconds + index / fps, crop
            index += 1
    finally:
        proc.stdout.close()
        proc.terminate()
        proc.wait(timeout=10)


def locate(source: Path, duration: float, probe_count: int) -> BugRect | None:
    offsets = np.linspace(0.05, 0.95, probe_count) * duration
    frames = []
    for t in offsets:
        frame = extract_frame(source, float(t))
        if frame is not None:
            frames.append(frame)
    if not frames:
        return None
    return locate_scorebug(frames)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="path to the VOD file")
    parser.add_argument("--out", type=Path, required=True, help="output directory")
    parser.add_argument("--fps", type=float, default=1.0, help="sampling rate")
    parser.add_argument("--start-seconds", type=float, default=0.0)
    parser.add_argument("--max-seconds", type=float, default=None)
    parser.add_argument("--probe-count", type=int, default=8)
    parser.add_argument(
        "--bug-rect",
        type=str,
        default=None,
        help="skip location: x,y,width,height in source pixels",
    )
    parser.add_argument("--vote-frames", type=int, default=2)
    parser.add_argument("--anomaly-frames", type=int, default=4)
    parser.add_argument(
        "--ocr-scale",
        type=int,
        default=3,
        help="integer upscale before OCR; small lone digits need >=3",
    )
    parser.add_argument("--progress-every", type=float, default=600.0)
    args = parser.parse_args(argv)

    if not args.source.is_file():
        parser.error(f"source not found: {args.source}")
    duration = probe_duration_seconds(args.source)

    if args.bug_rect:
        x, y, w, h = (int(v) for v in args.bug_rect.split(","))
        rect = BugRect(x=x, y=y, width=w, height=h)
    else:
        print(f"locating scorebug ({args.probe_count} probe frames)...", flush=True)
        rect = locate(args.source, duration, args.probe_count)
        if rect is None:
            print("ERROR: scorebug not found in probe frames", file=sys.stderr)
            return 2
    print(f"scorebug rect: x={rect.x} y={rect.y} {rect.width}x{rect.height}", flush=True)

    timeline = ScoreTimeline(
        vote_frames=args.vote_frames, anomaly_frames=args.anomaly_frames
    )
    started = time.monotonic()
    processed = 0
    next_progress = args.start_seconds + args.progress_every
    for t_seconds, crop in stream_crops(
        args.source,
        rect,
        fps=args.fps,
        start_seconds=args.start_seconds,
        max_seconds=args.max_seconds,
    ):
        if args.ocr_scale > 1:
            crop = np.repeat(
                np.repeat(crop, args.ocr_scale, axis=0), args.ocr_scale, axis=1
            )
        timeline.observe(parse_scorebug(crop, t_seconds))
        processed += 1
        if t_seconds >= next_progress:
            elapsed = time.monotonic() - started
            rate = processed / elapsed if elapsed else 0.0
            print(
                f"  t={t_seconds:7.0f}s  {processed} frames  "
                f"{rate:5.1f} fps  {timeline.summary()['points']} points",
                flush=True,
            )
            while next_progress <= t_seconds:
                next_progress += args.progress_every
    timeline.finish()

    args.out.mkdir(parents=True, exist_ok=True)
    write_outputs(timeline, args.out)
    with open(args.out / "run.json", "w") as f:
        json.dump(
            {
                "source": str(args.source),
                "duration_seconds": duration,
                "fps": args.fps,
                "bug_rect": dataclasses.asdict(rect),
                "vote_frames": args.vote_frames,
                "anomaly_frames": args.anomaly_frames,
                "wall_seconds": round(time.monotonic() - started, 1),
            },
            f,
            indent=2,
        )
    print(json.dumps(timeline.summary(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
