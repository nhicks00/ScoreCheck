import { describe, expect, it } from "vitest";
import { apiScoreHasPriority } from "../lib/sourcePriority";

const vblMatch = {
  api_url: "https://api.volleyballlife.com/api/v1.0/matches/123/vmix?bracket=true",
  source_type: "vbl"
};

describe("apiScoreHasPriority", () => {
  it("blocks human official scoring when a primary live API score is available", () => {
    expect(apiScoreHasPriority({
      source: "api",
      source_available: true,
      source_priority: "primary",
      stale: false,
      status: "In Progress",
      team_a_score: 0,
      team_b_score: 0
    }, vblMatch)).toBe(true);
  });

  it("keeps an admin override authoritative until explicitly cleared", () => {
    expect(apiScoreHasPriority({
      source: "override",
      source_available: true,
      source_priority: "override",
      stale: false,
      status: "In Progress",
      team_a_score: 12,
      team_b_score: 9
    }, vblMatch)).toBe(true);
  });

  it("allows human scoring when the API score is fallback, unavailable, or stale", () => {
    expect(apiScoreHasPriority({
      source: "api",
      source_available: false,
      source_priority: "primary",
      stale: false,
      status: "In Progress"
    }, vblMatch)).toBe(false);

    expect(apiScoreHasPriority({
      source: "api",
      source_available: true,
      source_priority: "fallback",
      stale: false,
      status: "In Progress"
    }, vblMatch)).toBe(false);

    expect(apiScoreHasPriority({
      source: "api",
      source_available: true,
      source_priority: "primary",
      stale: true,
      status: "In Progress"
    }, vblMatch)).toBe(false);
  });

  it("does not prioritize API scoring for manual matches or non-live API rows", () => {
    expect(apiScoreHasPriority({
      source: "api",
      source_available: true,
      source_priority: "primary",
      stale: false,
      status: "In Progress"
    }, { ...vblMatch, source_type: "manual" })).toBe(false);

    expect(apiScoreHasPriority({
      source: "api",
      source_available: true,
      source_priority: "primary",
      stale: false,
      status: "Pre-Match",
      team_a_score: 0,
      team_b_score: 0,
      set_scores: []
    }, vblMatch)).toBe(false);
  });

  it("treats current-set scoring as live API evidence but ignores completed set history alone", () => {
    expect(apiScoreHasPriority({
      source: "api",
      source_available: true,
      source_priority: "primary",
      stale: false,
      status: "Pre-Match",
      team_a_score: 1,
      team_b_score: 0
    }, vblMatch)).toBe(true);

    expect(apiScoreHasPriority({
      source: "api",
      source_available: true,
      source_priority: "primary",
      stale: false,
      status: "Pre-Match",
      set_scores: [{ setNumber: 1, teamAScore: 21, teamBScore: 19, isComplete: true }]
    }, vblMatch)).toBe(false);

    expect(apiScoreHasPriority({
      source: "api",
      source_available: true,
      source_priority: "primary",
      stale: false,
      status: "In Progress",
      team_a_score: 0,
      team_b_score: 0,
      team_a_sets: 1,
      team_b_sets: 0,
      set_scores: [{ setNumber: 1, teamAScore: 21, teamBScore: 19, isComplete: true }]
    }, vblMatch)).toBe(false);

    expect(apiScoreHasPriority({
      source: "api",
      source_available: true,
      source_priority: "primary",
      stale: false,
      status: "In Progress",
      set_scores: [
        { setNumber: 1, teamAScore: 21, teamBScore: 19, isComplete: true },
        { setNumber: 2, teamAScore: 3, teamBScore: 2, isComplete: false }
      ]
    }, vblMatch)).toBe(true);
  });
});
