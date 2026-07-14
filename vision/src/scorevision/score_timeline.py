"""Volleyball-legal score timeline reconstruction from scorebug readings.

Consumes per-frame ``ScorebugReading`` values (typically sampled at 1 fps) and
produces a committed timeline of score states plus derived events. Robustness
comes from two mechanisms validated in prior art (SmartTennisTV's scoring
automaton, the ASAP scorebug pipeline):

- **multi-frame voting**: a changed reading must repeat on ``vote_frames``
  consecutive samples before it is considered at all;
- **legal-successor filtering**: a voted reading is committed immediately only
  when it is a legal volleyball continuation (exactly one team +1 within a
  set, a set transition that freezes a plausible final, a match change, or a
  FINAL flag). Anything else — operator corrections, overlay glitches, missed
  spans — must persist for ``anomaly_frames`` consecutive samples, then commits
  with an explanatory event instead of being silently absorbed.

The parser reads the current-set score directly from the gold overlay cell,
so per-set finals arrive separately (dim-white cells) and are treated as
advisory: they seed mid-match joins and cross-check set transitions, but the
committed state's finals come from scores the tracker froze itself.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from enum import Enum

from .scorebug import ScorebugReading

_IDENTITY_JUNK_RE = re.compile(r"[^A-Z0-9]+")


def normalize_team_identity(name: str) -> str:
    """Collapse punctuation/whitespace jitter for match-identity comparison.

    OCR reads the same overlay name with drifting spacing around slashes
    ('JACKSON / WOOD' vs 'JACKSON/ WOOD'); comparing raw strings fabricates
    dozens of phantom match restarts per stream.
    """

    return _IDENTITY_JUNK_RE.sub(" ", name.upper()).strip()


REGULAR_SET_TARGET = 21
DECIDING_SET_TARGET = 15
DECIDING_SET_NUMBER = 3


class EventKind(str, Enum):
    MATCH_START = "MATCH_START"
    POINT = "POINT"
    SET_END = "SET_END"
    SET_START = "SET_START"
    MATCH_FINAL = "MATCH_FINAL"
    CORRECTION = "CORRECTION"
    SCORE_JUMP = "SCORE_JUMP"
    ANOMALY = "ANOMALY"


@dataclass(frozen=True, slots=True)
class TimelineEvent:
    kind: EventKind
    t_seconds: float
    match_number: int | None
    set_number: int | None
    detail: dict

    def to_json(self) -> dict:
        return {
            "kind": self.kind.value,
            "t_seconds": round(self.t_seconds, 3),
            "match_number": self.match_number,
            "set_number": self.set_number,
            **self.detail,
        }


@dataclass(slots=True)
class MatchState:
    match_number: int | None
    name_a: str
    name_b: str
    seed_a: int | None
    seed_b: int | None
    set_number: int = 1
    finals_a: list[int] = field(default_factory=list)
    finals_b: list[int] = field(default_factory=list)
    score_a: int = 0
    score_b: int = 0
    finished: bool = False

    def key(self) -> tuple:
        return (
            self.match_number,
            normalize_team_identity(self.name_a),
            normalize_team_identity(self.name_b),
        )


@dataclass(frozen=True, slots=True)
class _Candidate:
    """A parsed reading awaiting voting/commit."""

    match_number: int | None
    name_a: str
    name_b: str
    seed_a: int | None
    seed_b: int | None
    set_number: int | None
    current_a: int
    current_b: int
    finals_a: str
    finals_b: str
    is_final: bool

    def key(self) -> tuple:
        return (
            self.match_number,
            normalize_team_identity(self.name_a),
            normalize_team_identity(self.name_b),
        )


def _set_target(set_number: int) -> int:
    return DECIDING_SET_TARGET if set_number >= DECIDING_SET_NUMBER else REGULAR_SET_TARGET


def plausible_set_final(a: int, b: int, set_number: int) -> bool:
    """True when (a, b) is a believable completed-set score."""
    high, low = max(a, b), min(a, b)
    target = _set_target(set_number)
    if high < target:
        return False
    if high == target:
        return high - low >= 2
    return high - low == 2  # extended deuce ends exactly two apart


def split_finals_digits(digits: str, completed_sets: int) -> list[int] | None:
    """Split a concatenated finals string into per-set values.

    Beach set finals are two digits in practice (21/15 minimum targets), so
    consume two digits per completed set.
    """

    finals: list[int] = []
    rest = digits
    for _ in range(completed_sets):
        if len(rest) < 2:
            return None
        finals.append(int(rest[:2]))
        rest = rest[2:]
    if rest:
        return None
    return finals


class ScoreTimeline:
    """Streaming tracker: feed readings in time order, read events/states."""

    def __init__(self, *, vote_frames: int = 2, anomaly_frames: int = 4) -> None:
        if vote_frames < 1 or anomaly_frames < vote_frames:
            raise ValueError("need anomaly_frames >= vote_frames >= 1")
        self.vote_frames = vote_frames
        self.anomaly_frames = anomaly_frames
        self.match: MatchState | None = None
        self.events: list[TimelineEvent] = []
        self.committed_states: list[dict] = []
        self.readings_seen = 0
        self.readings_unparsed = 0
        self.readings_rejected = 0
        self._pending: _Candidate | None = None
        self._pending_count = 0
        self._pending_first_t = 0.0

    # -- public API ---------------------------------------------------------

    def observe(self, reading: ScorebugReading | None) -> None:
        self.readings_seen += 1
        if reading is None or not reading.has_scores:
            self.readings_unparsed += 1
            self._pending = None
            self._pending_count = 0
            return
        assert reading.row_a.current_score is not None
        assert reading.row_b.current_score is not None
        candidate = _Candidate(
            match_number=reading.match_number,
            name_a=reading.row_a.name,
            name_b=reading.row_b.name,
            seed_a=reading.row_a.seed,
            seed_b=reading.row_b.seed,
            set_number=reading.set_number,
            current_a=reading.row_a.current_score,
            current_b=reading.row_b.current_score,
            finals_a=reading.row_a.finals_digits or "",
            finals_b=reading.row_b.finals_digits or "",
            is_final=reading.is_final,
        )
        if self._matches_committed(candidate):
            self._pending = None
            self._pending_count = 0
            return
        if self._pending is not None and self._same_claim(candidate, self._pending):
            self._pending_count += 1
            self._pending = candidate
        else:
            self._pending = candidate
            self._pending_count = 1
            self._pending_first_t = reading.t_seconds
        if self._pending_count >= self.vote_frames:
            self._try_commit(candidate, self._pending_first_t)

    def finish(self) -> None:
        if self.match is not None and not self.match.finished:
            self._emit(
                EventKind.ANOMALY,
                self.committed_states[-1]["t_seconds"] if self.committed_states else 0.0,
                {"reason": "stream ended before FINAL", "state": self._state_json()},
            )

    def summary(self) -> dict:
        points = [e for e in self.events if e.kind is EventKind.POINT]
        return {
            "readings_seen": self.readings_seen,
            "readings_unparsed": self.readings_unparsed,
            "readings_rejected": self.readings_rejected,
            "committed_states": len(self.committed_states),
            "matches": len([e for e in self.events if e.kind is EventKind.MATCH_START]),
            "finals": len([e for e in self.events if e.kind is EventKind.MATCH_FINAL]),
            "points": len(points),
            "corrections": len([e for e in self.events if e.kind is EventKind.CORRECTION]),
            "jumps": len([e for e in self.events if e.kind is EventKind.SCORE_JUMP]),
            "anomalies": len([e for e in self.events if e.kind is EventKind.ANOMALY]),
        }

    # -- internals ----------------------------------------------------------

    @staticmethod
    def _same_claim(a: _Candidate, b: _Candidate) -> bool:
        """Voting equality: the score/state claim, tolerant of OCR jitter in
        advisory fields (finals digits and seeds occasionally drop out)."""
        return (
            a.key() == b.key()
            and a.set_number == b.set_number
            and a.current_a == b.current_a
            and a.current_b == b.current_b
            and a.is_final == b.is_final
        )

    def _matches_committed(self, c: _Candidate) -> bool:
        m = self.match
        if m is None:
            return False
        if c.key() != m.key():
            return False
        if c.is_final != m.finished:
            return False
        if c.set_number is not None and not m.finished and c.set_number != m.set_number:
            return False
        return c.current_a == m.score_a and c.current_b == m.score_b

    def _try_commit(self, c: _Candidate, first_t: float) -> None:
        m = self.match
        if m is None or c.key() != m.key():
            self._commit_new_match(c, first_t)
            return
        if m.finished:
            # Same match shown after FINAL: steady postgame bug; ignore.
            self._pending = None
            self._pending_count = 0
            return

        if self._legal_transition(m, c, first_t):
            self._pending = None
            self._pending_count = 0
            self._record_state(first_t)
            return

        # Not legal: allow persistent non-legal states through as
        # corrections/jumps once they have survived anomaly_frames.
        if self._pending_count >= self.anomaly_frames:
            self._commit_anomalous(m, c, first_t)
            self._pending = None
            self._pending_count = 0
            self._record_state(first_t)
        else:
            self.readings_rejected += 1

    def _commit_new_match(self, c: _Candidate, t: float) -> None:
        if self._pending_count < self.anomaly_frames:
            # Team/match changes are big claims; require the longer vote.
            self.readings_rejected += 1
            return
        set_number = c.set_number or 1
        completed = max(0, set_number - 1)
        finals_a = split_finals_digits(c.finals_a, completed)
        finals_b = split_finals_digits(c.finals_b, completed)
        if finals_a is None or finals_b is None:
            self.readings_rejected += 1
            return
        for idx, (fa, fb) in enumerate(zip(finals_a, finals_b), start=1):
            if not plausible_set_final(fa, fb, idx):
                self.readings_rejected += 1
                return
        if self.match is not None and not self.match.finished:
            self._emit(
                EventKind.ANOMALY,
                t,
                {
                    "reason": "match replaced before FINAL",
                    "state": self._state_json(),
                    "replacement": {"a": c.name_a, "b": c.name_b, "match": c.match_number},
                },
            )
        self.match = MatchState(
            match_number=c.match_number,
            name_a=c.name_a,
            name_b=c.name_b,
            seed_a=c.seed_a,
            seed_b=c.seed_b,
            set_number=set_number,
            finals_a=finals_a,
            finals_b=finals_b,
            score_a=c.current_a,
            score_b=c.current_b,
            finished=False,
        )
        self._pending = None
        self._pending_count = 0
        self._emit(
            EventKind.MATCH_START,
            t,
            {
                "teams": {"a": c.name_a, "b": c.name_b},
                "seeds": {"a": c.seed_a, "b": c.seed_b},
                "joined_mid_match": bool(
                    finals_a or c.current_a or c.current_b or set_number > 1
                ),
            },
        )
        if c.is_final:
            self.match.finished = True
            self._emit(EventKind.MATCH_FINAL, t, {"state": self._state_json()})
        self._record_state(t)

    def _legal_transition(self, m: MatchState, c: _Candidate, t: float) -> bool:
        cand_set = c.set_number if c.set_number is not None else m.set_number

        # Same set: exactly one team gained exactly one point.
        if cand_set == m.set_number and not c.is_final:
            if c.current_a == m.score_a + 1 and c.current_b == m.score_b:
                m.score_a = c.current_a
                self._emit_point(m, t, "A")
                return True
            if c.current_b == m.score_b + 1 and c.current_a == m.score_a:
                m.score_b = c.current_b
                self._emit_point(m, t, "B")
                return True
            return False

        # Set transition: committed scores freeze into finals; the next set
        # shows 0-0 (or 1-0/0-1 when sampling caught a quick first rally).
        # The set-closing point routinely never survives voting — the bug
        # rolls to the next set within a second or two of the final rally —
        # so accept a committed score one point short of a plausible final
        # and emit that POINT first.
        if cand_set == m.set_number + 1 and not c.is_final:
            if c.current_a + c.current_b > 1:
                return False
            closing_point: str | None = None
            if not plausible_set_final(m.score_a, m.score_b, m.set_number):
                closed_by_a = plausible_set_final(m.score_a + 1, m.score_b, m.set_number)
                closed_by_b = plausible_set_final(m.score_a, m.score_b + 1, m.set_number)
                if closed_by_a and not closed_by_b:
                    closing_point = "A"
                elif closed_by_b and not closed_by_a:
                    closing_point = "B"
                else:
                    return False
            if closing_point == "A":
                m.score_a += 1
                self._emit_point(m, t, "A")
            elif closing_point == "B":
                m.score_b += 1
                self._emit_point(m, t, "B")
            self._emit(
                EventKind.SET_END,
                t,
                {
                    "set_final": {"a": m.score_a, "b": m.score_b},
                    "winner": "A" if m.score_a > m.score_b else "B",
                },
            )
            m.finals_a.append(m.score_a)
            m.finals_b.append(m.score_b)
            m.set_number = cand_set
            m.score_a, m.score_b = c.current_a, c.current_b
            self._emit(EventKind.SET_START, t, {})
            return True

        # FINAL: the meta strip replaced SET n; the gold cell keeps the
        # final set's score (possibly one point ahead of the last commit).
        if c.is_final:
            last_point: str | None
            if c.current_a == m.score_a + 1 and c.current_b == m.score_b:
                last_point = "A"
            elif c.current_b == m.score_b + 1 and c.current_a == m.score_a:
                last_point = "B"
            elif c.current_a == m.score_a and c.current_b == m.score_b:
                last_point = ""
            else:
                return False
            if not plausible_set_final(c.current_a, c.current_b, m.set_number):
                return False
            m.score_a, m.score_b = c.current_a, c.current_b
            if last_point:
                self._emit_point(m, t, last_point)
            m.finished = True
            self._emit(EventKind.MATCH_FINAL, t, {"state": self._state_json()})
            return True

        return False

    def _commit_anomalous(self, m: MatchState, c: _Candidate, t: float) -> None:
        cand_set = c.set_number if c.set_number is not None else m.set_number
        finals_a, finals_b = list(m.finals_a), list(m.finals_b)
        if cand_set != m.set_number:
            completed = max(0, cand_set - 1)
            split_a = split_finals_digits(c.finals_a, completed)
            split_b = split_finals_digits(c.finals_b, completed)
            if split_a is None or split_b is None:
                self._emit(
                    EventKind.ANOMALY,
                    t,
                    {
                        "reason": "persistent reading with unreconstructable finals",
                        "reading": {
                            "set": cand_set,
                            "current": [c.current_a, c.current_b],
                            "finals": [c.finals_a, c.finals_b],
                        },
                    },
                )
                return
            finals_a, finals_b = split_a, split_b
        went_down = c.current_a < m.score_a or c.current_b < m.score_b
        kind = EventKind.CORRECTION if went_down and cand_set == m.set_number else EventKind.SCORE_JUMP
        self._emit(
            kind,
            t,
            {
                "from": {"a": m.score_a, "b": m.score_b, "set": m.set_number},
                "to": {"a": c.current_a, "b": c.current_b, "set": cand_set},
            },
        )
        m.set_number = cand_set
        m.finals_a, m.finals_b = finals_a, finals_b
        m.score_a, m.score_b = c.current_a, c.current_b
        if c.is_final:
            m.finished = True
            self._emit(EventKind.MATCH_FINAL, t, {"state": self._state_json()})

    def _emit_point(self, m: MatchState, t: float, winner: str) -> None:
        self._emit(
            EventKind.POINT,
            t,
            {
                "winner": winner,
                "score": {"a": m.score_a, "b": m.score_b},
                "combined": m.score_a + m.score_b,
            },
        )

    def _emit(self, kind: EventKind, t: float, detail: dict) -> None:
        m = self.match
        self.events.append(
            TimelineEvent(
                kind=kind,
                t_seconds=t,
                match_number=m.match_number if m else None,
                set_number=m.set_number if m else None,
                detail=detail,
            )
        )

    def _state_json(self) -> dict:
        m = self.match
        if m is None:
            return {}
        return {
            "match_number": m.match_number,
            "teams": {"a": m.name_a, "b": m.name_b},
            "set_number": m.set_number,
            "finals": {"a": list(m.finals_a), "b": list(m.finals_b)},
            "score": {"a": m.score_a, "b": m.score_b},
            "finished": m.finished,
        }

    def _record_state(self, t: float) -> None:
        self.committed_states.append({"t_seconds": round(t, 3), **self._state_json()})


# Label-quality tiers. Scorebug labels come from HUMAN live scoring, so each
# rally is graded by the noise fingerprints the tracker itself observed:
# - excluded: within TAINT_RADIUS_S of a correction/jump/anomaly in the same
#   match — attribution and timing are both unreliable there;
# - silver: winner is probably right but timing is suspect (batch entry:
#   committed implausibly soon after the previous point, or synthesized as a
#   set-closing point at the set-transition commit);
# - gold: clean, isolated, plausibly timed commits.
TAINT_RADIUS_S = 45.0
MIN_PLAUSIBLE_GAP_S = 12.0


def events_to_rallies(events: list[TimelineEvent]) -> list[dict]:
    """Derive tiered rally-outcome labels: each POINT commit is a rally end."""

    taint_times: dict[int | None, list[float]] = {}
    for event in events:
        if event.kind in (EventKind.CORRECTION, EventKind.SCORE_JUMP, EventKind.ANOMALY):
            taint_times.setdefault(event.match_number, []).append(event.t_seconds)
    set_end_times = {
        (e.match_number, e.t_seconds) for e in events if e.kind is EventKind.SET_END
    }

    points = [e for e in events if e.kind is EventKind.POINT]
    rallies: list[dict] = []
    for index, event in enumerate(points):
        tainted = any(
            abs(event.t_seconds - t) <= TAINT_RADIUS_S
            for t in taint_times.get(event.match_number, [])
        )
        gap_prev = (
            event.t_seconds - points[index - 1].t_seconds
            if index > 0 and points[index - 1].match_number == event.match_number
            else None
        )
        gap_next = (
            points[index + 1].t_seconds - event.t_seconds
            if index + 1 < len(points)
            and points[index + 1].match_number == event.match_number
            else None
        )
        batch_suspect = (gap_prev is not None and gap_prev < MIN_PLAUSIBLE_GAP_S) or (
            gap_next is not None and gap_next < MIN_PLAUSIBLE_GAP_S
        )
        # A set-closing point synthesized at the set-transition commit has
        # correct attribution but late, artificial timing.
        synthesized = (event.match_number, event.t_seconds) in set_end_times
        if tainted:
            tier = "excluded"
        elif batch_suspect or synthesized:
            tier = "silver"
        else:
            tier = "gold"
        rallies.append(
            {
                "rally_end_t": event.t_seconds,
                "winner": event.detail["winner"],
                "score_after": event.detail["score"],
                "match_number": event.match_number,
                "set_number": event.set_number,
                "tier": tier,
            }
        )
    return rallies


def write_outputs(timeline: ScoreTimeline, out_dir) -> None:
    from pathlib import Path

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "events.jsonl", "w") as f:
        for event in timeline.events:
            f.write(json.dumps(event.to_json()) + "\n")
    with open(out / "states.jsonl", "w") as f:
        for state in timeline.committed_states:
            f.write(json.dumps(state) + "\n")
    with open(out / "rallies.json", "w") as f:
        json.dump(events_to_rallies(timeline.events), f, indent=2)
    with open(out / "summary.json", "w") as f:
        json.dump(timeline.summary(), f, indent=2)
