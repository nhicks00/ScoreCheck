"""Regenerate tiered rallies.json for every labeled corpus VOD.

Rebuilds rally labels (with gold/silver/excluded quality tiers) from each
VOD's existing labels/events.jsonl — no video decode needed — so tier-policy
changes can be re-applied to the whole corpus in seconds.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from scorevision.score_timeline import EventKind, TimelineEvent, events_to_rallies  # noqa: E402


def load_events(path: Path) -> list[TimelineEvent]:
    events = []
    for line in path.read_text().splitlines():
        record = json.loads(line)
        detail = {
            k: v
            for k, v in record.items()
            if k not in ("kind", "t_seconds", "match_number", "set_number")
        }
        events.append(
            TimelineEvent(
                kind=EventKind(record["kind"]),
                t_seconds=float(record["t_seconds"]),
                match_number=record.get("match_number"),
                set_number=record.get("set_number"),
                detail=detail,
            )
        )
    return events


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    args = parser.parse_args()

    grand = Counter()
    for vod_dir in sorted(args.corpus.iterdir()):
        events_path = vod_dir / "labels" / "events.jsonl"
        if not events_path.is_file():
            continue
        rallies = events_to_rallies(load_events(events_path))
        (vod_dir / "labels" / "rallies.json").write_text(json.dumps(rallies, indent=1))
        tiers = Counter(r["tier"] for r in rallies)
        grand.update(tiers)
        print(f"{vod_dir.name}: {dict(tiers)}")
    print(f"total: {dict(grand)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
