import { describe, expect, it } from "vitest";
import { delayedScoreFromSnapshot, isDelayedScoreBehindVisible, pendingScoresForMatch, queueDelayedVblScore, shouldHoldDelayedFinalScore, splitDueDelayedVblScores } from "../lib/vblDelay";

const startedAt = "2026-07-03T15:00:00.000Z";
const snapshot = {
  status: "In Progress",
  currentSet: 1,
  teamAName: "Alpha",
  teamBName: "Bravo",
  teamAScore: 3,
  teamBScore: 2,
  teamASets: 0,
  teamBSets: 0,
  servingTeam: null,
  setScores: [{ setNumber: 1, teamAScore: 3, teamBScore: 2, isComplete: false }],
  source: "api" as const,
  stale: false,
  message: null
};

describe("VBL overlay delay queue", () => {
  it("queues live VBL snapshots for a six-second release", () => {
    const delayed = delayedScoreFromSnapshot("match-1", snapshot, startedAt);
    expect(delayed.visibleAt).toBe("2026-07-03T15:00:06.000Z");

    const queued = queueDelayedVblScore([], null, delayed);
    expect(splitDueDelayedVblScores(queued, "2026-07-03T15:00:05.999Z")).toMatchObject({
      latestDue: null,
      remaining: queued
    });

    const due = splitDueDelayedVblScores(queued, "2026-07-03T15:00:06.000Z");
    expect(due.latestDue?.score).toMatchObject({
      match_id: "match-1",
      team_a_score: 3,
      team_b_score: 2,
      status: "In Progress"
    });
    expect(due.remaining).toEqual([]);
  });

  it("does not duplicate a score that is already visible or already pending", () => {
    const delayed = delayedScoreFromSnapshot("match-1", snapshot, startedAt);
    const visible = {
      match_id: "match-1",
      team_a_score: 3,
      team_b_score: 2,
      team_a_sets: 0,
      team_b_sets: 0,
      current_set: 1,
      set_scores: [{ setNumber: 1, teamAScore: 3, teamBScore: 2, isComplete: false }],
      status: "In Progress"
    };

    expect(queueDelayedVblScore([], visible, delayed)).toEqual([]);

    const once = queueDelayedVblScore([], null, delayed);
    const twice = queueDelayedVblScore(once, null, delayed);
    expect(twice).toHaveLength(1);
    expect(twice[0].visibleAt).toBe("2026-07-03T15:00:06.000Z");
  });

  it("removes stale pending entries once that score is already visible", () => {
    const delayed = delayedScoreFromSnapshot("match-1", snapshot, startedAt);
    const visible = {
      match_id: "match-1",
      team_a_score: 3,
      team_b_score: 2,
      team_a_sets: 0,
      team_b_sets: 0,
      current_set: 1,
      set_scores: [{ setNumber: 1, teamAScore: 3, teamBScore: 2, isComplete: false }],
      status: "In Progress"
    };

    expect(queueDelayedVblScore([delayed], visible, delayed)).toEqual([]);
  });

  it("drops delayed scores from a previous match", () => {
    const matchOneScore = delayedScoreFromSnapshot("match-1", snapshot, startedAt);
    const matchTwoScore = delayedScoreFromSnapshot("match-2", { ...snapshot, teamAScore: 0, teamBScore: 1 }, startedAt);

    expect(pendingScoresForMatch([matchOneScore, matchTwoScore], "match-2")).toEqual([matchTwoScore]);
  });

  it("detects delayed VBL scores that would move the visible score backward", () => {
    const delayed = delayedScoreFromSnapshot("match-1", {
      ...snapshot,
      currentSet: 2,
      teamAScore: 20,
      teamBScore: 14,
      teamASets: 1,
      teamBSets: 0,
      setScores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 20, teamBScore: 14, isComplete: false }
      ]
    }, startedAt);
    const visible = {
      match_id: "match-1",
      team_a_score: 20,
      team_b_score: 18,
      team_a_sets: 1,
      team_b_sets: 0,
      current_set: 2,
      set_scores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 20, teamBScore: 18, isComplete: false }
      ],
      status: "In Progress"
    };

    expect(isDelayedScoreBehindVisible(delayed.score, visible)).toBe(true);
  });

  it("allows a later official final to correct an earlier final score", () => {
    const delayed = delayedScoreFromSnapshot("match-1", {
      ...snapshot,
      status: "Final",
      currentSet: 2,
      teamAScore: 21,
      teamBScore: 18,
      teamASets: 2,
      teamBSets: 0,
      setScores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 21, teamBScore: 18, isComplete: true }
      ]
    }, startedAt);
    const visible = {
      match_id: "match-1",
      team_a_score: 21,
      team_b_score: 14,
      team_a_sets: 2,
      team_b_sets: 0,
      current_set: 2,
      set_scores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 21, teamBScore: 14, isComplete: true }
      ],
      status: "Final"
    };

    expect(isDelayedScoreBehindVisible(delayed.score, visible)).toBe(false);
  });

  it("replaces pre-final pending scores with a final candidate for the same match", () => {
    const inProgress = delayedScoreFromSnapshot("match-1", {
      ...snapshot,
      currentSet: 2,
      teamAScore: 20,
      teamBScore: 18,
      teamASets: 1,
      teamBSets: 0,
      setScores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 20, teamBScore: 18, isComplete: false }
      ]
    }, startedAt);
    const final = delayedScoreFromSnapshot("match-1", {
      ...snapshot,
      status: "Final",
      currentSet: 2,
      teamAScore: 21,
      teamBScore: 18,
      teamASets: 2,
      teamBSets: 0,
      setScores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 21, teamBScore: 18, isComplete: true }
      ]
    }, "2026-07-03T15:00:02.000Z");

    const queued = queueDelayedVblScore([inProgress], null, final);

    expect(queued).toHaveLength(1);
    expect(queued[0].score.status).toBe("Final");
    expect(queued[0].score.team_b_score).toBe(18);
  });

  it("ignores in-progress snapshots once a final candidate is pending", () => {
    const final = delayedScoreFromSnapshot("match-1", {
      ...snapshot,
      status: "Final",
      currentSet: 2,
      teamAScore: 21,
      teamBScore: 18,
      teamASets: 2,
      teamBSets: 0,
      setScores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 21, teamBScore: 18, isComplete: true }
      ]
    }, startedAt);
    const regressed = delayedScoreFromSnapshot("match-1", {
      ...snapshot,
      currentSet: 2,
      teamAScore: 20,
      teamBScore: 18,
      teamASets: 1,
      teamBSets: 0,
      setScores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 20, teamBScore: 18, isComplete: false }
      ]
    }, "2026-07-03T15:00:02.000Z");

    expect(queueDelayedVblScore([final], null, regressed)).toEqual([final]);
  });

  it("holds a due final while a newer final correction is still pending", () => {
    const firstFinal = delayedScoreFromSnapshot("match-1", {
      ...snapshot,
      status: "Final",
      currentSet: 2,
      teamAScore: 21,
      teamBScore: 14,
      teamASets: 2,
      teamBSets: 0,
      setScores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 21, teamBScore: 14, isComplete: true }
      ]
    }, startedAt);
    const correctedFinal = delayedScoreFromSnapshot("match-1", {
      ...snapshot,
      status: "Final",
      currentSet: 2,
      teamAScore: 21,
      teamBScore: 18,
      teamASets: 2,
      teamBSets: 0,
      setScores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 14, isComplete: true },
        { setNumber: 2, teamAScore: 21, teamBScore: 18, isComplete: true }
      ]
    }, "2026-07-03T15:00:04.000Z");

    expect(shouldHoldDelayedFinalScore(firstFinal, [correctedFinal], "2026-07-03T15:00:22.000Z")).toBe(true);
    expect(shouldHoldDelayedFinalScore(correctedFinal, [], "2026-07-03T15:00:21.999Z")).toBe(true);
    expect(shouldHoldDelayedFinalScore(correctedFinal, [], "2026-07-03T15:00:22.000Z")).toBe(false);
  });
});
