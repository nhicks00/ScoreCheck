import { describe, expect, it } from "vitest";
import { recordForCurrentMatch } from "../lib/currentMatch";

describe("current-match relation selection", () => {
  const historical = { match_id: "old", team_a_score: 21 };
  const current = { match_id: "current", team_a_score: 7 };

  it("returns null for an idle court even when historical rows are present", () => {
    expect(recordForCurrentMatch([historical, current], null)).toBeNull();
    expect(recordForCurrentMatch(historical, undefined)).toBeNull();
  });

  it("returns only the row matching the current match", () => {
    expect(recordForCurrentMatch([historical, current], "current")).toEqual(current);
    expect(recordForCurrentMatch(historical, "current")).toBeNull();
  });
});
