"""M2 corpus builder: download owned endline VODs, label, archive to NAS.

Per VOD (33 primary endline candidates from the checked-in catalog):
  1. skip when already archived on the NAS,
  2. yt-dlp download to fast local staging (video-only mp4 <=1080p + m4a),
  3. run the scorebug labeler + rally-window derivation on the staged file,
  4. move everything to ``<corpus>/<video_id>/`` on the NAS,
  5. clear staging (bounded local disk use — one VOD at a time).

Failures are logged per-VOD and the sweep continues; rerunning is idempotent.
NAS access is strictly confined to the corpus root the operator provided
(``/Volumes/Nathan Footage/CV TRAINING DATA``).

Usage:
    uv run --project vision python vision/scripts/build_corpus.py \
        --corpus "/Volumes/Nathan Footage/CV TRAINING DATA/corpus" [--limit N]
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CATALOG = REPO / "vision" / "data" / "provided-youtube-livestream-sources-v1.json"
BWK_QUARANTINE = Path(
    "~/.codex/vision-media-quarantine/owner-youtube-denver-2026/bWK0AihsH5g"
).expanduser()

ALLOWED_NAS_ROOT = Path("/Volumes/Nathan Footage/CV TRAINING DATA")


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def candidates() -> list[dict]:
    catalog = json.loads(CATALOG.read_text())
    return [s for s in catalog["sources"] if s.get("primary_endline_candidate")]


def download(url: str, video_id: str, stage: Path) -> Path | None:
    """Download one VOD; returns the video file path or None."""
    out_dir = stage / video_id
    out_dir.mkdir(parents=True, exist_ok=True)
    base_cmd = [
        "yt-dlp",
        "-f",
        "bv*[ext=mp4][height<=1080]+ba[ext=m4a]/bv*[ext=mp4][height<=1080]/b[ext=mp4]",
        "--no-overwrites",
        "--continue",
        "--write-info-json",
        "--no-playlist",
        "-o",
        str(out_dir / f"{video_id}.%(ext)s"),
        url,
    ]
    for attempt, extra in enumerate(([], ["--cookies-from-browser", "chrome"])):
        result = subprocess.run(
            base_cmd[:1] + extra + base_cmd[1:],
            capture_output=True,
            text=True,
            timeout=4 * 3600,
        )
        if result.returncode == 0:
            break
        log(f"  yt-dlp attempt {attempt + 1} failed: {result.stderr.strip()[-300:]}")
    else:
        return None
    videos = sorted(out_dir.glob(f"{video_id}*.mp4"), key=lambda p: p.stat().st_size)
    return videos[-1] if videos else None


def label(video: Path, out_dir: Path) -> bool:
    result = subprocess.run(
        [
            "uv",
            "run",
            "--project",
            str(REPO / "vision"),
            "scorevision-label",
            str(video),
            "--out",
            str(out_dir),
        ],
        capture_output=True,
        text=True,
        timeout=4 * 3600,
    )
    if result.returncode != 0:
        log(f"  labeler failed: {result.stderr.strip()[-300:]}")
        return False
    rallies = out_dir / "rallies.json"
    if not rallies.is_file():
        return False
    windows = subprocess.run(
        [
            "uv",
            "run",
            "--project",
            str(REPO / "vision"),
            "scorevision-windows",
            str(video),
            "--rallies",
            str(rallies),
            "--out",
            str(out_dir / "windows.json"),
        ],
        capture_output=True,
        text=True,
        timeout=4 * 3600,
    )
    if windows.returncode != 0:
        log(f"  windows failed (labels kept): {windows.stderr.strip()[-200:]}")
    return True


def archive_to_nas(src_dir: Path, dest_dir: Path) -> None:
    dest_dir.parent.mkdir(parents=True, exist_ok=True)
    staging_dest = dest_dir.with_name(dest_dir.name + ".partial")
    if staging_dest.exists():
        shutil.rmtree(staging_dest)
    shutil.copytree(src_dir, staging_dest)
    staging_dest.rename(dest_dir)


def seed_bwk(stage: Path) -> None:
    """Reuse the already-downloaded bWK VOD + v3 labels instead of refetching."""
    video = BWK_QUARANTINE / "bWK0AihsH5g.format-137.mp4"
    if not video.is_file():
        return
    out_dir = stage / "bWK0AihsH5g"
    out_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(video, out_dir / "bWK0AihsH5g.mp4")
    audio = BWK_QUARANTINE / "bWK0AihsH5g.format-140.m4a"
    if audio.is_file():
        shutil.copy2(audio, out_dir / "bWK0AihsH5g.m4a")
    info = BWK_QUARANTINE / "bWK0AihsH5g.format-137.info.json"
    if info.is_file():
        shutil.copy2(info, out_dir / "bWK0AihsH5g.info.json")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--stage", type=Path, default=Path.home() / ".scorevision-stage")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--only", default=None, help="process a single video id")
    parser.add_argument("--skip-download", action="store_true", help="label/archive staged files only")
    args = parser.parse_args()

    corpus: Path = args.corpus
    try:
        corpus.resolve().relative_to(ALLOWED_NAS_ROOT.resolve())
    except ValueError:
        if str(corpus).startswith("/Volumes/"):
            parser.error(
                f"corpus on a NAS volume must live under '{ALLOWED_NAS_ROOT}'"
            )
    corpus.mkdir(parents=True, exist_ok=True)
    args.stage.mkdir(parents=True, exist_ok=True)

    todo = candidates()
    if args.only:
        todo = [s for s in todo if s["platform_video_id"] == args.only]
    if args.limit:
        todo = todo[: args.limit]
    done = failed = skipped = 0
    for index, source in enumerate(todo, 1):
        video_id = source["platform_video_id"]
        url = source["canonical_watch_url"]
        dest = corpus / video_id
        if (dest / "labels" / "summary.json").is_file():
            skipped += 1
            continue
        log(f"[{index}/{len(todo)}] {video_id} ({source.get('catalog_duration_seconds')}s)")
        stage_dir = args.stage / video_id
        try:
            if video_id == "bWK0AihsH5g" and not stage_dir.is_dir():
                seed_bwk(args.stage)
            video = next(iter(sorted(stage_dir.glob(f"{video_id}*.mp4"))), None)
            if video is None and not args.skip_download:
                video = download(url, video_id, args.stage)
            if video is None:
                log("  no video; skipping")
                failed += 1
                continue
            labels_dir = stage_dir / "labels"
            if not (labels_dir / "summary.json").is_file():
                if not label(video, labels_dir):
                    failed += 1
                    # Archive the video anyway; labels can be rerun later.
            log(f"  archiving to NAS ({sum(f.stat().st_size for f in stage_dir.rglob('*') if f.is_file()) / 1e9:.1f} GB)")
            archive_to_nas(stage_dir, dest)
            shutil.rmtree(stage_dir)
            done += 1
            summary_file = dest / "labels" / "summary.json"
            if summary_file.is_file():
                log(f"  done: {json.loads(summary_file.read_text())}")
        except Exception as error:  # noqa: BLE001 - sweep must continue
            log(f"  ERROR {video_id}: {error}")
            failed += 1
    log(f"sweep complete: {done} archived, {skipped} already present, {failed} failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
