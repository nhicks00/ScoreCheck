"""Build the SERVICE / PLAY / NO-PLAY dataset manifest from the corpus.

Weak labels derive from the score timeline + activity windows (no humans):
- PLAY: inside an activity-backed rally window (gold/silver rallies only);
- SERVICE: a short span at the start of an activity-backed gold rally window
  (the serve initiates the rally);
- NO-PLAY: gaps between rally windows with a safety margin on both sides.

Output is a JSONL manifest of {video_id, t0, t1, label, split, tier} segments;
training cuts the actual (scorebug-masked) clips lazily so tier/label policy
changes never require re-encoding video. Splits come from the pinned
split-manifest — segments never cross splits because VODs don't.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

SERVICE_SPAN_S = 3.0
NO_PLAY_MARGIN_S = 8.0
NO_PLAY_SEGMENT_S = 4.0
MAX_NO_PLAY_PER_GAP = 3


def segments_for_vod(
    video_id: str,
    windows: list[dict],
    rallies: list[dict],
    split: str,
) -> list[dict]:
    tier_by_end = {round(r["rally_end_t"], 1): r["tier"] for r in rallies if "tier" in r}
    segments: list[dict] = []
    usable = []
    for window in windows:
        tier = tier_by_end.get(round(window["end_t"], 1), "gold")
        if tier == "excluded":
            continue
        usable.append((window, tier))
        if window.get("activity_backed"):
            segments.append(
                {
                    "video_id": video_id,
                    "t0": round(window["start_t"], 2),
                    "t1": round(window["end_t"], 2),
                    "label": "PLAY",
                    "split": split,
                    "tier": tier,
                }
            )
            if tier == "gold":
                segments.append(
                    {
                        "video_id": video_id,
                        "t0": round(window["start_t"], 2),
                        "t1": round(window["start_t"] + SERVICE_SPAN_S, 2),
                        "label": "SERVICE",
                        "split": split,
                        "tier": tier,
                    }
                )
    # NO-PLAY from inter-window gaps (only between usable windows, so a
    # correction-tainted zone never becomes a "no play" example either).
    for (prev, _), (nxt, _) in zip(usable, usable[1:]):
        gap_start = prev["end_t"] + NO_PLAY_MARGIN_S
        gap_end = nxt["start_t"] - NO_PLAY_MARGIN_S
        count = 0
        t = gap_start
        while t + NO_PLAY_SEGMENT_S <= gap_end and count < MAX_NO_PLAY_PER_GAP:
            segments.append(
                {
                    "video_id": video_id,
                    "t0": round(t, 2),
                    "t1": round(t + NO_PLAY_SEGMENT_S, 2),
                    "label": "NO_PLAY",
                    "split": split,
                    "tier": "gold",
                }
            )
            count += 1
            t += (gap_end - gap_start) / MAX_NO_PLAY_PER_GAP
    return segments


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--split-manifest", type=Path, default=None)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    manifest_path = args.split_manifest or (args.corpus / "split-manifest.json")
    split_manifest = json.loads(manifest_path.read_text())
    split_of = {s["video_id"]: s["split"] for s in split_manifest["sources"]}

    all_segments: list[dict] = []
    for vod_dir in sorted(args.corpus.iterdir()):
        labels = vod_dir / "labels"
        if not (labels / "windows.json").is_file() or not (labels / "rallies.json").is_file():
            continue
        windows = json.loads((labels / "windows.json").read_text())
        rallies = json.loads((labels / "rallies.json").read_text())
        split = split_of.get(vod_dir.name, "train")
        all_segments.extend(segments_for_vod(vod_dir.name, windows, rallies, split))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w") as f:
        for segment in all_segments:
            f.write(json.dumps(segment) + "\n")

    from collections import Counter

    counts = Counter((s["split"], s["label"]) for s in all_segments)
    for key in sorted(counts):
        print(f"{key[0]:>9} {key[1]:<8} {counts[key]}")
    print(f"total {len(all_segments)} segments -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
