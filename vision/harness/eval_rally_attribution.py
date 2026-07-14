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

Label-noise handling: scorebug labels are human-entered live scoring, tiered
gold/silver/excluded by the labeler. Winner accuracy is scored on GOLD
matches only by default (the human-timing-suspect and correction-adjacent
labels don't gate models), and a timing-insensitive sequence metric
(per-set winner-order edit similarity over gold+silver) is reported so lag
in human entry cannot masquerade as model error.
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


def _edit_distance(a: str, b: str) -> int:
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i]
        for j, cb in enumerate(b, 1):
            current.append(
                min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb))
            )
        previous = current
    return previous[-1]


def sequence_similarity(predicted: list[dict], actual: list[dict]) -> tuple[float, int]:
    """Timing-insensitive metric: per-set winner-order edit similarity.

    Groups rallies by (match, set), forms winner strings in chronological
    order, and averages 1 - editdist/maxlen over sets. Robust to human entry
    lag because only the ORDER of winners matters.
    """

    def by_set(rallies: list[dict]) -> dict[tuple, str]:
        grouped: dict[tuple, list[dict]] = {}
        for rally in rallies:
            grouped.setdefault(
                (rally.get("match_number"), rally.get("set_number")), []
            ).append(rally)
        return {
            key: "".join(
                str(r["winner"]) for r in sorted(group, key=lambda r: r["rally_end_t"])
            )
            for key, group in grouped.items()
        }

    actual_sets = by_set(actual)
    predicted_sets = by_set(predicted)
    if not actual_sets:
        return 0.0, 0
    scores = []
    for key, truth_seq in actual_sets.items():
        pred_seq = predicted_sets.get(key, "")
        longest = max(len(truth_seq), len(pred_seq), 1)
        scores.append(1.0 - _edit_distance(truth_seq, pred_seq) / longest)
    return sum(scores) / len(scores), len(scores)


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
    seq_scores: list[float] = []
    seq_sets = 0
    for video_id in video_ids:
        all_truth = truth.get(video_id, [])
        # Winner accuracy gates on GOLD labels only; older label files
        # without tiers count everything (tier defaults to gold).
        gold_truth = [r for r in all_truth if r.get("tier", "gold") == "gold"]
        usable_truth = [r for r in all_truth if r.get("tier", "gold") != "excluded"]
        tp, fp, fn, correct = match_rallies(
            predictions.get(video_id, []), gold_truth, args.tolerance
        )
        totals["tp"] += tp
        totals["fp"] += fp
        totals["fn"] += fn
        totals["correct"] += correct
        similarity, n_sets = sequence_similarity(
            predictions.get(video_id, []), usable_truth
        )
        if n_sets:
            seq_scores.append(similarity)
            seq_sets += n_sets
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
    if seq_scores:
        print(f"sequence metric over {seq_sets} sets (timing-insensitive):")
        print(f"METRIC sequence_similarity={sum(seq_scores) / len(seq_scores):.4f}")
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
