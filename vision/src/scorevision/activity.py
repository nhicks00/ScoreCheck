"""Per-second motion activity signal and rally-window derivation.

A cheap 1 Hz frame-difference scan (ffmpeg ``tblend=difference`` +
``signalstats`` luma average on a 160x90 downscale) distinguishes active play
from dead time between rallies. Joined with the score timeline's POINT commit
times, it turns "the score changed at t" into "the rally ran from roughly
t_start to t_end" — the spans needed to cut training clips for game-state and
ball models.
"""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path

_YAVG_RE = re.compile(r"lavfi\.signalstats\.YAVG=(?P<value>[0-9.]+)")
_PTS_RE = re.compile(r"pts_time:(?P<t>[0-9.]+)")


def activity_signal(
    source: Path,
    *,
    start_seconds: float = 0.0,
    max_seconds: float | None = None,
    crop: str | None = None,
) -> list[tuple[float, float]]:
    """Return (t_seconds, mean-abs-luma-difference) at ~1 Hz.

    ``crop`` (ffmpeg ``w:h:x:y``) restricts the signal to a region — pass the
    court area to ignore scoreboard animation and background motion.
    """

    filters = ["fps=1", "scale=160:90"]
    if crop:
        filters.insert(0, f"crop={crop}")
    filters += ["tblend=all_mode=difference", "signalstats", "metadata=print"]
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-ss", f"{start_seconds:.3f}", "-i", str(source)]
    if max_seconds is not None:
        cmd += ["-t", f"{max_seconds:.3f}"]
    cmd += ["-vf", ",".join(filters), "-f", "null", "-"]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    samples: list[tuple[float, float]] = []
    current_t: float | None = None
    for line in result.stderr.splitlines():
        pts = _PTS_RE.search(line)
        if pts:
            current_t = start_seconds + float(pts.group("t"))
            continue
        yavg = _YAVG_RE.search(line)
        if yavg and current_t is not None:
            samples.append((current_t, float(yavg.group("value"))))
            current_t = None
    return samples


@dataclass(frozen=True, slots=True)
class RallyWindow:
    start_t: float
    end_t: float
    winner: str
    score_after: dict
    match_number: int | None
    set_number: int | None
    activity_backed: bool


def derive_rally_windows(
    rallies: list[dict],
    signal: list[tuple[float, float]],
    *,
    quiet_quantile: float = 0.35,
    active_factor: float = 1.8,
    pre_commit_slack: float = 6.0,
    max_rally_seconds: float = 90.0,
    min_rally_seconds: float = 4.0,
) -> list[RallyWindow]:
    """Assign a [start, end] span to each score-commit rally label.

    The activity threshold adapts to the footage: ``quiet`` is the
    ``quiet_quantile`` of the signal, and a sample is *active* when it
    exceeds ``quiet * active_factor``. Walking backwards from each commit,
    the rally start is the beginning of the last sustained active run; when
    no activity data covers the span, the window falls back to a fixed
    pre-commit slice and is flagged ``activity_backed=False``.
    """

    values = sorted(v for _, v in signal)
    if values:
        quiet = values[max(0, int(len(values) * quiet_quantile) - 1)]
        threshold = max(quiet * active_factor, quiet + 0.5)
    else:
        threshold = None
    times = [t for t, _ in signal]

    windows: list[RallyWindow] = []
    prev_commit = None
    for rally in rallies:
        commit_t = float(rally["rally_end_t"])
        end_t = commit_t
        earliest = commit_t - max_rally_seconds
        if prev_commit is not None:
            earliest = max(earliest, prev_commit + 1.0)
        start_t = commit_t - pre_commit_slack - min_rally_seconds
        backed = False
        if threshold is not None and times:
            # Find the last sustained active run before the commit.
            import bisect

            hi = bisect.bisect_right(times, commit_t)
            lo = bisect.bisect_left(times, earliest)
            run_end = None
            run_start = None
            for index in range(hi - 1, lo - 1, -1):
                t, value = signal[index]
                if value >= threshold:
                    run_end = run_end if run_end is not None else t
                    run_start = t
                elif run_end is not None and run_end - t > 4.0:
                    break
            if run_start is not None and run_end is not None:
                start_t = run_start - 1.0
                backed = True
        start_t = max(start_t, earliest)
        if end_t - start_t < min_rally_seconds:
            start_t = end_t - min_rally_seconds
        windows.append(
            RallyWindow(
                start_t=round(start_t, 3),
                end_t=round(end_t, 3),
                winner=rally["winner"],
                score_after=rally["score_after"],
                match_number=rally.get("match_number"),
                set_number=rally.get("set_number"),
                activity_backed=backed,
            )
        )
        prev_commit = commit_t
    return windows


def main() -> int:
    import argparse
    import dataclasses

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--rallies", type=Path, required=True, help="rallies.json from the labeler")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--crop", default=None, help="court region w:h:x:y")
    parser.add_argument("--start-seconds", type=float, default=0.0)
    parser.add_argument("--max-seconds", type=float, default=None)
    args = parser.parse_args()

    rallies = json.loads(args.rallies.read_text())
    signal = activity_signal(
        args.source,
        start_seconds=args.start_seconds,
        max_seconds=args.max_seconds,
        crop=args.crop,
    )
    windows = derive_rally_windows(rallies, signal)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps([dataclasses.asdict(w) for w in windows], indent=1)
    )
    backed = sum(1 for w in windows if w.activity_backed)
    print(f"windows: {len(windows)} ({backed} activity-backed) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
