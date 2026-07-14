"""Behavioral tests for the volleyball-legal score timeline tracker."""

from __future__ import annotations

import unittest

from scorevision.scorebug import RowReading, ScorebugReading
from scorevision.score_timeline import (
    EventKind,
    ScoreTimeline,
    events_to_rallies,
    plausible_set_final,
    split_finals_digits,
)


def reading(
    t: float,
    score_a: int | None,
    score_b: int | None,
    *,
    finals_a: str | None = None,
    finals_b: str | None = None,
    set_number: int | None = 1,
    match_number: int | None = 14,
    final: bool = False,
    name_a: str = "THEO BRUNNER / RYAN WILCOX",
    name_b: str = "ALEXANDER HARTHALLER / DIEGO PEREZ",
) -> ScorebugReading:
    return ScorebugReading(
        t_seconds=t,
        court=14,
        set_number=set_number,
        match_number=match_number,
        is_final=final,
        row_a=RowReading(
            seed=7, name=name_a, current_score=score_a, finals_digits=finals_a, serving=False
        ),
        row_b=RowReading(
            seed=18, name=name_b, current_score=score_b, finals_digits=finals_b, serving=False
        ),
    )


def feed(timeline: ScoreTimeline, frames: list[ScorebugReading | None]) -> None:
    for frame in frames:
        timeline.observe(frame)


class SplitFinalsTest(unittest.TestCase):
    def test_zero_sets(self) -> None:
        self.assertEqual(split_finals_digits("", 0), [])

    def test_one_set(self) -> None:
        self.assertEqual(split_finals_digits("21", 1), [21])

    def test_two_sets(self) -> None:
        self.assertEqual(split_finals_digits("2115", 2), [21, 15])

    def test_rejects_leftover(self) -> None:
        self.assertIsNone(split_finals_digits("211", 1))

    def test_rejects_short(self) -> None:
        self.assertIsNone(split_finals_digits("2", 1))


class PlausibleFinalTest(unittest.TestCase):
    def test_regulation(self) -> None:
        self.assertTrue(plausible_set_final(21, 19, 1))
        self.assertTrue(plausible_set_final(23, 21, 2))
        self.assertTrue(plausible_set_final(15, 13, 3))

    def test_rejects(self) -> None:
        self.assertFalse(plausible_set_final(21, 20, 1))
        self.assertFalse(plausible_set_final(24, 21, 1))
        self.assertFalse(plausible_set_final(14, 12, 1))


class TimelineTest(unittest.TestCase):
    def test_match_start_requires_persistence(self) -> None:
        timeline = ScoreTimeline(vote_frames=2, anomaly_frames=4)
        feed(timeline, [reading(float(i), 0, 0) for i in range(3)])
        self.assertEqual(timeline.summary()["matches"], 0)
        feed(timeline, [reading(3.0, 0, 0)])
        self.assertEqual(timeline.summary()["matches"], 1)

    def _started(self) -> ScoreTimeline:
        timeline = ScoreTimeline(vote_frames=2, anomaly_frames=4)
        feed(timeline, [reading(float(i), 0, 0) for i in range(4)])
        return timeline

    def test_point_commits_after_vote(self) -> None:
        timeline = self._started()
        feed(timeline, [reading(10.0, 1, 0)])
        self.assertEqual(timeline.summary()["points"], 0)
        feed(timeline, [reading(11.0, 1, 0)])
        points = [e for e in timeline.events if e.kind is EventKind.POINT]
        self.assertEqual(len(points), 1)
        self.assertEqual(points[0].detail["winner"], "A")
        self.assertEqual(points[0].t_seconds, 10.0)  # first-seen time

    def test_single_frame_glitch_rejected(self) -> None:
        timeline = self._started()
        feed(
            timeline,
            [
                reading(10.0, 7, 0),  # OCR glitch: jumped score
                reading(11.0, 1, 0),
                reading(12.0, 1, 0),
            ],
        )
        points = [e for e in timeline.events if e.kind is EventKind.POINT]
        self.assertEqual(len(points), 1)
        self.assertEqual(timeline.summary()["jumps"], 0)

    def test_set_transition_freezes_finals(self) -> None:
        timeline = self._started()
        m = timeline.match
        assert m is not None
        m.score_a, m.score_b = 21, 19
        feed(
            timeline,
            [
                reading(100.0, 0, 0, finals_a="21", finals_b="19", set_number=2),
                reading(101.0, 0, 0, finals_a="21", finals_b="19", set_number=2),
            ],
        )
        self.assertEqual(m.finals_a, [21])
        self.assertEqual(m.finals_b, [19])
        self.assertEqual((m.score_a, m.score_b), (0, 0))
        kinds = [e.kind for e in timeline.events]
        self.assertIn(EventKind.SET_END, kinds)
        self.assertIn(EventKind.SET_START, kinds)

    def test_set_transition_rejected_for_implausible_final(self) -> None:
        timeline = self._started()
        m = timeline.match
        assert m is not None
        m.score_a, m.score_b = 12, 9  # not a completed set
        feed(
            timeline,
            [reading(100.0 + i, 0, 0, set_number=2) for i in range(3)],
        )
        self.assertEqual(m.set_number, 1)
        self.assertEqual(timeline.summary()["jumps"], 0)

    def test_points_in_second_set(self) -> None:
        timeline = self._started()
        m = timeline.match
        assert m is not None
        m.set_number, m.finals_a, m.finals_b = 2, [21], [19]
        m.score_a, m.score_b = 10, 12
        feed(
            timeline,
            [
                reading(200.0, 10, 13, finals_a="21", finals_b="19", set_number=2),
                reading(201.0, 10, 13, finals_a="21", finals_b="19", set_number=2),
            ],
        )
        self.assertEqual((m.score_a, m.score_b), (10, 13))

    def test_correction_needs_anomaly_persistence(self) -> None:
        timeline = self._started()
        m = timeline.match
        assert m is not None
        m.score_a, m.score_b = 5, 4
        frames = [reading(50.0 + i, 4, 4) for i in range(4)]
        feed(timeline, frames[:3])
        self.assertEqual(timeline.summary()["corrections"], 0)
        feed(timeline, frames[3:])
        self.assertEqual(timeline.summary()["corrections"], 1)
        self.assertEqual((m.score_a, m.score_b), (4, 4))

    def test_final_commits_match(self) -> None:
        timeline = self._started()
        m = timeline.match
        assert m is not None
        m.set_number, m.finals_a, m.finals_b = 2, [21], [19]
        m.score_a, m.score_b = 21, 14
        feed(
            timeline,
            [
                reading(300.0, 21, 14, set_number=None, final=True),
                reading(301.0, 21, 14, set_number=None, final=True),
            ],
        )
        self.assertTrue(m.finished)
        self.assertEqual(timeline.summary()["finals"], 1)

    def test_final_with_last_point_in_same_commit(self) -> None:
        timeline = self._started()
        m = timeline.match
        assert m is not None
        m.set_number, m.finals_a, m.finals_b = 2, [21], [19]
        m.score_a, m.score_b = 20, 14
        feed(
            timeline,
            [
                reading(300.0, 21, 14, set_number=None, final=True),
                reading(301.0, 21, 14, set_number=None, final=True),
            ],
        )
        self.assertTrue(m.finished)
        points = [e for e in timeline.events if e.kind is EventKind.POINT]
        self.assertEqual(points[-1].detail["score"], {"a": 21, "b": 14})

    def test_new_match_replaces_finished(self) -> None:
        timeline = self._started()
        m = timeline.match
        assert m is not None
        m.set_number, m.finals_a, m.finals_b = 2, [21], [19]
        m.score_a, m.score_b = 21, 14
        feed(
            timeline,
            [reading(300.0 + i, 21, 14, set_number=None, final=True) for i in range(2)],
        )
        feed(
            timeline,
            [
                reading(
                    400.0 + i,
                    0,
                    0,
                    match_number=15,
                    name_a="TEAM C",
                    name_b="TEAM D",
                )
                for i in range(4)
            ],
        )
        self.assertEqual(timeline.summary()["matches"], 2)
        m2 = timeline.match
        assert m2 is not None
        self.assertEqual(m2.match_number, 15)
        self.assertFalse(m2.finished)

    def test_join_mid_match_uses_finals_digits(self) -> None:
        timeline = ScoreTimeline(vote_frames=2, anomaly_frames=4)
        feed(
            timeline,
            [
                reading(float(i), 7, 5, finals_a="21", finals_b="19", set_number=2)
                for i in range(4)
            ],
        )
        m = timeline.match
        assert m is not None
        self.assertEqual(m.finals_a, [21])
        self.assertEqual(m.finals_b, [19])
        self.assertEqual((m.score_a, m.score_b), (7, 5))
        starts = [e for e in timeline.events if e.kind is EventKind.MATCH_START]
        self.assertTrue(starts[0].detail["joined_mid_match"])

    def test_join_mid_match_rejected_without_finals(self) -> None:
        timeline = ScoreTimeline(vote_frames=2, anomaly_frames=4)
        feed(
            timeline,
            [reading(float(i), 7, 5, set_number=2) for i in range(6)],
        )
        self.assertIsNone(timeline.match)

    def test_unparsed_frames_reset_pending(self) -> None:
        timeline = self._started()
        feed(timeline, [reading(10.0, 1, 0), None, reading(12.0, 1, 0)])
        # The None between the two "1-0" frames resets the consecutive vote.
        self.assertEqual(timeline.summary()["points"], 0)

    def test_finals_jitter_does_not_reset_vote(self) -> None:
        timeline = self._started()
        feed(
            timeline,
            [
                reading(10.0, 1, 0, finals_a=None),
                reading(11.0, 1, 0, finals_a="9"),  # advisory-field OCR noise
            ],
        )
        self.assertEqual(timeline.summary()["points"], 1)

    def test_rally_labels(self) -> None:
        timeline = self._started()
        feed(
            timeline,
            [
                reading(10.0, 1, 0),
                reading(11.0, 1, 0),
                reading(40.0, 1, 1),
                reading(41.0, 1, 1),
            ],
        )
        rallies = events_to_rallies(timeline.events)
        self.assertEqual(len(rallies), 2)
        self.assertEqual(rallies[0]["winner"], "A")
        self.assertEqual(rallies[1]["winner"], "B")
        self.assertEqual(rallies[1]["rally_end_t"], 40.0)


if __name__ == "__main__":
    unittest.main()
