import { describe, expect, it } from "vitest";
import { delayedScoreFromSnapshot, pendingScoresForMatch, queueDelayedVblScore, splitDueDelayedVblScores } from "../lib/vblDelay";

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

  it("drops delayed scores from a previous match", () => {
    const matchOneScore = delayedScoreFromSnapshot("match-1", snapshot, startedAt);
    const matchTwoScore = delayedScoreFromSnapshot("match-2", { ...snapshot, teamAScore: 0, teamBScore: 1 }, startedAt);

    expect(pendingScoresForMatch([matchOneScore, matchTwoScore], "match-2")).toEqual([matchTwoScore]);
  });
});
