import { describe, expect, it } from "vitest";
import { backupPromotionRank, isPromotionHandoffPending, reduceAction } from "../lib/scorerSessions";
import type { ScoreState } from "../lib/scoringRules";

const official: ScoreState = {
  teamAScore: 2,
  teamBScore: 2,
  teamASets: 0,
  teamBSets: 0,
  currentSet: 1,
  setScores: [],
  servingTeam: null,
  status: "In Progress"
};

describe("scorer session reliability helpers", () => {
  it("requires a handoff when a promoted backup has a different shadow score", () => {
    const shadow = { ...official, teamAScore: 6, teamBScore: 4 };
    expect(isPromotionHandoffPending({ role: "active", status: "promoted" }, official, shadow)).toBe(true);
  });

  it("does not require a handoff for normal active sessions or aligned scores", () => {
    expect(isPromotionHandoffPending({ role: "active", status: "active" }, official, { ...official, teamAScore: 6 })).toBe(false);
    expect(isPromotionHandoffPending({ role: "active", status: "promoted" }, official, official)).toBe(false);
    expect(isPromotionHandoffPending({ role: "backup", status: "active" }, official, { ...official, teamAScore: 6 })).toBe(false);
  });

  it("ranks courtside and recently active backups ahead of idle backups", () => {
    const now = new Date("2026-07-03T12:00:00.000Z");
    const idle = backupPromotionRank({
      priority_score: 0,
      watch_mode: "website",
      last_action_at: null,
      last_heartbeat_at: "2026-07-03T11:59:55.000Z"
    }, now);
    const courtsideRecent = backupPromotionRank({
      priority_score: 0,
      watch_mode: "courtside",
      last_action_at: "2026-07-03T11:59:50.000Z",
      last_heartbeat_at: "2026-07-03T11:59:55.000Z"
    }, now);

    expect(courtsideRecent).toBeGreaterThan(idle);
  });

  it("rejects scorer mutations after a match is final", () => {
    const finalScore: ScoreState = { ...official, status: "Final" };

    expect(() => reduceAction(finalScore, null, "POINT_A")).toThrow("already final");
    expect(() => reduceAction(finalScore, null, "MANUAL_CORRECTION", { score: official })).toThrow("already final");
  });
});
