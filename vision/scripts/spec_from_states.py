"""Generate a digit-template harvest spec from a labeler run's states.jsonl.

Each committed state that holds for at least ``--min-hold`` seconds yields one
[t, score_a, score_b] harvest sample a few seconds into the span — turning a
verified run into hundreds of labeled digit exemplars for re-harvesting a
richer template bank.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("states", type=Path, help="states.jsonl from a labeler run")
    parser.add_argument("--events", type=Path, default=None, help="events.jsonl; states near corrections/jumps/anomalies are excluded as unreliable labels")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--min-hold", type=float, default=6.0)
    parser.add_argument("--offset", type=float, default=3.0)
    parser.add_argument("--taint-radius", type=float, default=25.0)
    parser.add_argument("--limit", type=int, default=120)
    args = parser.parse_args()

    tainted: list[float] = []
    if args.events:
        for line in args.events.read_text().splitlines():
            event = json.loads(line)
            if event["kind"] in ("CORRECTION", "SCORE_JUMP", "ANOMALY"):
                tainted.append(float(event["t_seconds"]))

    states = [json.loads(line) for line in args.states.read_text().splitlines()]
    samples: list[list[float | int]] = []
    for current, following in zip(states, states[1:]):
        hold = following["t_seconds"] - current["t_seconds"]
        if hold < args.min_hold or current.get("finished"):
            continue
        t_state = current["t_seconds"]
        if any(abs(t_state - t) <= args.taint_radius for t in tainted):
            continue
        samples.append(
            [
                round(current["t_seconds"] + args.offset, 1),
                current["score"]["a"],
                current["score"]["b"],
            ]
        )
    # Prefer digit variety: rank samples so scores containing rarer digits
    # (8, 0 in tens position, etc.) survive the cap.
    frequency: dict[str, int] = {}
    for _, a, b in samples:
        for ch in f"{a}{b}":
            frequency[ch] = frequency.get(ch, 0) + 1
    samples.sort(key=lambda s: min(frequency[ch] for ch in f"{s[1]}{s[2]}"))
    samples = samples[: args.limit]
    samples.sort()
    args.out.write_text(json.dumps(samples))
    print(f"{len(samples)} harvest samples -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
