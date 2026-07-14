"""Build the leakage-safe train/val/test split manifest for the NAS corpus.

Splits are assigned per SOURCE VOD (which contains whole matches) and grouped
by venue/production so no match — and ideally no venue-day — spans splits.
Frames or rallies from one match must never appear in two splits
(vision/README.md leakage rules).

Policy (deterministic, pinned here):
- TEST: every non-Denver venue (Austin, Huntington, Santa Barbara, Miami —
  the Colorado Cupcakes channel productions) plus two pinned Denver courts.
  Cross-venue testing is the honest generalization measure.
- VAL: two pinned Denver VODs.
- TRAIN: everything else.

Reruns are incremental: the manifest reflects whichever VODs have labels on
the NAS at run time, but assignments never change (they derive from the
catalog, not from arrival order).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CATALOG = REPO / "vision" / "data" / "provided-youtube-livestream-sources-v1.json"

# Pinned Denver holdouts (stable regardless of corpus arrival order).
DENVER_TEST_IDS = {"bWK0AihsH5g", "GZe0KO_I0QU"}
DENVER_VAL_IDS = {"BCg0RBo77ZI", "YWd0G4BcfZ0"}


def venue_of(title: str | None) -> str:
    text = (title or "").upper()
    for venue in ("DENVER", "AUSTIN", "HUNTINGTON", "SANTA BARBARA", "MIAMI"):
        if venue in text:
            return venue
    return "UNKNOWN"


def assign(video_id: str, venue: str) -> str:
    if video_id in DENVER_TEST_IDS or venue not in ("DENVER",):
        return "test"
    if video_id in DENVER_VAL_IDS:
        return "val"
    return "train"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=None, help="default: <corpus>/split-manifest.json")
    args = parser.parse_args()

    catalog = json.loads(CATALOG.read_text())
    entries = []
    totals = {"train": 0, "val": 0, "test": 0}
    rally_totals = {"train": 0, "val": 0, "test": 0}
    for source in catalog["sources"]:
        if not source.get("primary_endline_candidate"):
            continue
        video_id = source["platform_video_id"]
        venue = venue_of(source.get("catalog_title"))
        split = assign(video_id, venue)
        labels_dir = args.corpus / video_id / "labels"
        summary = None
        rallies = 0
        if (labels_dir / "summary.json").is_file():
            summary = json.loads((labels_dir / "summary.json").read_text())
            rallies = summary.get("points", 0)
        entries.append(
            {
                "video_id": video_id,
                "venue": venue,
                "split": split,
                "labeled": summary is not None,
                "rallies": rallies,
                "matches": (summary or {}).get("matches", 0),
                "duration_seconds": source.get("catalog_duration_seconds"),
            }
        )
        if summary is not None:
            totals[split] += 1
            rally_totals[split] += rallies

    manifest = {
        "policy": "split by source VOD (whole matches); non-Denver venues + 2 pinned Denver courts = test; 2 pinned Denver = val",
        "labeled_vods": totals,
        "labeled_rallies": rally_totals,
        "sources": entries,
    }
    out = args.out or (args.corpus / "split-manifest.json")
    out.write_text(json.dumps(manifest, indent=1))
    print(json.dumps({"labeled_vods": totals, "labeled_rallies": rally_totals}, indent=1))
    print(f"-> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
