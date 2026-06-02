import { describe, expect, it } from "vitest";
import { normalizeScorePayload } from "../lib/scoring";
import { parseVblUrl } from "../lib/vbl";

describe("VolleyballLife helpers", () => {
  it("parses division, round, and pool URLs", () => {
    expect(parseVblUrl("https://volleyballlife.com/tournament/123?division=bad")).toBeNull();
    expect(parseVblUrl("https://volleyballlife.com/event/101/division/202/round/303/bracket")).toMatchObject({
      tournamentId: 101,
      divisionId: 202,
      dayId: 303,
      isBracket: true
    });
    expect(parseVblUrl("https://volleyballlife.com/event/101/division/202/round/303/pools/404")).toMatchObject({
      poolId: 404,
      isPool: true
    });
  });

  it("normalizes vMix array payload scores", () => {
    const snapshot = normalizeScorePayload([
      { players: "Alpha", seed: "1", game1: 21, game2: 18, game3: 15 },
      { players: "Bravo", seed: "2", game1: 19, game2: 21, game3: 13 }
    ], {
      team_a: "TBD",
      team_b: "TBD",
      format: { bestOf: 3, pointsPerSet: [21, 21, 15], setsToWin: 2 }
    });

    expect(snapshot.teamAName).toBe("Alpha");
    expect(snapshot.teamBName).toBe("Bravo");
    expect(snapshot.status).toBe("Final");
    expect(snapshot.teamASets).toBe(2);
  });
});
