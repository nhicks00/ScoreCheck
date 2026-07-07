import { describe, expect, it } from "vitest";
import { mergeDiscoveredTeamFields } from "../lib/bracketRefresh";

describe("bracket refresh match upserts", () => {
  it("applies TD edits from the bracket over previously stored names", () => {
    expect(mergeDiscoveredTeamFields(
      { team_a: "Smith / Jones", team_b: "Lee / Park", team_a_seed: "3", team_b_seed: "6" },
      { team_a: "Smith / Johnson", team_b: "Lee / Parker", team_a_seed: "1", team_b_seed: "2" }
    )).toEqual({ team_a: "Smith / Jones", team_b: "Lee / Park", team_a_seed: "3", team_b_seed: "6" });
  });

  it("does not regress resolved team names to bracket placeholders", () => {
    expect(mergeDiscoveredTeamFields(
      { team_a: "Winner of Match 12", team_b: "TBD", team_a_seed: null, team_b_seed: null },
      { team_a: "Smith / Jones", team_b: "Lee / Park", team_a_seed: "4", team_b_seed: "5" }
    )).toEqual({ team_a: "Smith / Jones", team_b: "Lee / Park", team_a_seed: "4", team_b_seed: "5" });
  });

  it("keeps bracket placeholders when no resolved name exists yet", () => {
    expect(mergeDiscoveredTeamFields(
      { team_a: "Winner of Match 12", team_b: "Loser of Match 9", team_a_seed: null, team_b_seed: null },
      { team_a: "Team A", team_b: null, team_a_seed: null, team_b_seed: null }
    )).toEqual({ team_a: "Winner of Match 12", team_b: "Loser of Match 9", team_a_seed: null, team_b_seed: null });
  });

  it("passes discovered rows through when no existing match row is found", () => {
    expect(mergeDiscoveredTeamFields(
      { team_a: "Smith / Jones", team_b: null, team_a_seed: "1", team_b_seed: null },
      null
    )).toEqual({ team_a: "Smith / Jones", team_b: null, team_a_seed: "1", team_b_seed: null });
  });

  it("preserves extra row fields such as court and schedule updates", () => {
    const merged = mergeDiscoveredTeamFields(
      {
        team_a: "Winner of Match 12",
        team_b: "Lee / Park",
        team_a_seed: null,
        team_b_seed: "2",
        court_number: "7",
        scheduled_time: "1:30 PM"
      },
      { team_a: "Smith / Jones", team_b: "Lee / Park", team_a_seed: "4", team_b_seed: null }
    );

    expect(merged.court_number).toBe("7");
    expect(merged.scheduled_time).toBe("1:30 PM");
    expect(merged.team_a).toBe("Smith / Jones");
    expect(merged.team_a_seed).toBe("4");
    expect(merged.team_b_seed).toBe("2");
  });
});
