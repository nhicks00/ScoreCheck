"""Overlay-masked rally clip extraction for model training.

Cuts each rally window out of a VOD with the scorebug region black-filled.
Leakage control is non-negotiable (vision/README.md): a visible score bug is
a perfect label leak for any outcome model, so the mask box (the union of the
bug rect padded outward) is burned into every training clip. The unmasked VOD
remains the label source only.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from .scorebug import BugRect


def extract_clip(
    source: Path,
    out_path: Path,
    *,
    start_t: float,
    end_t: float,
    mask: BugRect | None,
    mask_pad: int = 12,
    reencode_crf: int = 18,
) -> None:
    duration = max(0.5, end_t - start_t)
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{start_t:.3f}",
        "-i",
        str(source),
        "-t",
        f"{duration:.3f}",
    ]
    if mask is not None:
        x = max(0, mask.x - mask_pad)
        y = max(0, mask.y - mask_pad)
        w = mask.width + 2 * mask_pad
        h = mask.height + 2 * mask_pad
        cmd += ["-vf", f"drawbox=x={x}:y={y}:w={w}:h={h}:color=black:t=fill"]
    cmd += [
        "-c:v",
        "libx264",
        "-crf",
        str(reencode_crf),
        "-preset",
        "fast",
        "-an",
        str(out_path),
    ]
    subprocess.run(cmd, check=True, timeout=600)


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--windows", type=Path, required=True, help="rally windows JSON")
    parser.add_argument("--out", type=Path, required=True, help="clip output directory")
    parser.add_argument(
        "--mask-rect",
        required=True,
        help="scorebug rect to black-fill: x,y,width,height (from run.json)",
    )
    parser.add_argument("--pre-roll", type=float, default=3.0)
    parser.add_argument("--post-roll", type=float, default=2.0)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    x, y, w, h = (int(v) for v in args.mask_rect.split(","))
    mask = BugRect(x=x, y=y, width=w, height=h)
    windows = json.loads(args.windows.read_text())
    if args.limit:
        windows = windows[: args.limit]
    args.out.mkdir(parents=True, exist_ok=True)

    manifest = []
    for index, window in enumerate(windows):
        start_t = float(window["start_t"]) - args.pre_roll
        end_t = float(window["end_t"]) + args.post_roll
        name = (
            f"rally-{index:04d}"
            f"-m{window.get('match_number') or 0:02d}"
            f"-s{window.get('set_number') or 0}"
            f"-{window['winner']}.mp4"
        )
        out_path = args.out / name
        extract_clip(
            args.source,
            out_path,
            start_t=max(0.0, start_t),
            end_t=end_t,
            mask=mask,
        )
        manifest.append({**window, "clip": name})
        print(f"  {name}  [{start_t:.1f} - {end_t:.1f}]", flush=True)

    (args.out / "clips.json").write_text(json.dumps(manifest, indent=1))
    print(f"{len(manifest)} clips -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
