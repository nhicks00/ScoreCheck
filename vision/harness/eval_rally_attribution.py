"""LOCKED evaluation harness: rally attribution vs scorebug ground truth.

This file is part of the trusted eval surface (vision/harness/). During
autonomous training campaigns the agent may RUN it but must never edit it,
and the ground-truth label directories for the selection/test splits are
mounted read-only. It is deliberately stdlib-only and imports nothing from
the agent-editable scorevision package, so it cannot be subverted indirectly.

Input: a predictions JSONL — one {"video_id", "rally_end_t", "winner"} per
predicted rally — plus the corpus root and the split manifest. Ground truth
is each video's labels/rallies.json (scorebug-derived).

Matching: greedy one-to-one within ±tolerance seconds. Outputs precision /
recall / F1 for rally detection, winner accuracy on matched rallies, per-slice
(venue) breakdowns, and machine-readable ``METRIC name=value`` lines.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_ground_truth(corpus: Path, video_ids: list[str]) -> dict[str, list[dict]]:
    truth: dict[str, list[dict]] = {}
    for video_id in video_ids:
        path = corpus / video_id / "labels" / "rallies.json"
        if path.is_file():
            truth[video_id] = json.loads(path.read_text())
    return truth


def match_rallies(
    predicted: list[dict], actual: list[dict], tolerance: float
) -> tuple[int, int, int, int]:
    """Greedy chronological matching; returns (tp, fp, fn, correct_winner)."""
    used = [False] * len(actual)
    tp = correct = 0
    for pred in sorted(predicted, key=lambda r: r["rally_end_t"]):
        best_index, best_delta = -1, tolerance + 1.0
        for index, act in enumerate(actual):
            if used[index]:
                continue
            delta = abs(float(act["rally_end_t"]) - float(pred["rally_end_t"]))
            if delta <= tolerance and delta < best_delta:
                best_index, best_delta = index, delta
        if best_index >= 0:
            used[best_index] = True
            tp += 1
            if str(pred.get("winner")) == str(actual[best_index].get("winner")):
                correct += 1
    fp = len(predicted) - tp
    fn = len(actual) - tp
    return tp, fp, fn, correct


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("predictions", type=Path, help="predictions JSONL")
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--split-manifest", type=Path, required=True)
    parser.add_argument("--split", default="selection", choices=["search", "selection", "test"])
    parser.add_argument("--tolerance", type=float, default=10.0, help="rally-end matching window, seconds")
    args = parser.parse_args()

    manifest = json.loads(args.split_manifest.read_text())
    split_sources = [
        s for s in manifest["sources"] if s["split"] == args.split and s["labeled"]
    ]
    video_ids = [s["video_id"] for s in split_sources]
    venue_of = {s["video_id"]: s["venue"] for s in split_sources}
    truth = load_ground_truth(args.corpus, video_ids)

    predictions: dict[str, list[dict]] = {v: [] for v in video_ids}
    with open(args.predictions) as f:
        for line in f:
            record = json.loads(line)
            if record["video_id"] in predictions:
                predictions[record["video_id"]].append(record)

    totals = {"tp": 0, "fp": 0, "fn": 0, "correct": 0}
    per_venue: dict[str, dict] = {}
    for video_id in video_ids:
        tp, fp, fn, correct = match_rallies(
            predictions.get(video_id, []), truth.get(video_id, []), args.tolerance
        )
        totals["tp"] += tp
        totals["fp"] += fp
        totals["fn"] += fn
        totals["correct"] += correct
        venue = venue_of[video_id]
        slot = per_venue.setdefault(venue, {"tp": 0, "fp": 0, "fn": 0, "correct": 0})
        slot["tp"] += tp
        slot["fp"] += fp
        slot["fn"] += fn
        slot["correct"] += correct

    def f1(tp: int, fp: int, fn: int) -> float:
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        return 2 * precision * recall / (precision + recall) if precision + recall else 0.0

    tp, fp, fn = totals["tp"], totals["fp"], totals["fn"]
    winner_acc = totals["correct"] / tp if tp else 0.0
    print(f"split={args.split} videos={len(video_ids)} truth_rallies={tp + fn}")
    print(f"METRIC rally_f1={f1(tp, fp, fn):.4f}")
    print(f"METRIC rally_precision={tp / (tp + fp) if tp + fp else 0.0:.4f}")
    print(f"METRIC rally_recall={tp / (tp + fn) if tp + fn else 0.0:.4f}")
    print(f"METRIC winner_accuracy={winner_acc:.4f}")
    for venue, s in sorted(per_venue.items()):
        acc = s["correct"] / s["tp"] if s["tp"] else 0.0
        print(
            f"METRIC slice_{venue.lower().replace(' ', '_')}_f1="
            f"{f1(s['tp'], s['fp'], s['fn']):.4f}"
        )
        print(f"METRIC slice_{venue.lower().replace(' ', '_')}_winner_acc={acc:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
