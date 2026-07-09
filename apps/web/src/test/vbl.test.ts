import { describe, expect, it } from "vitest";
import { isAuthoritativeScorePayload, normalizeScorePayload, normalizeVblBracketPayload } from "../lib/scoring";
import { discoverMatchesFromHydrate, parseVblUrl } from "../lib/vbl";

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

  it("uses the configured deciding-set target in vMix payloads", () => {
    const snapshot = normalizeScorePayload([
      { teamName: "Alpha", isMatch: true, game1: 21, game2: 18, game3: 11 },
      { teamName: "Bravo", isMatch: true, game1: 19, game2: 21, game3: 9 }
    ], {
      format: { bestOf: 3, pointsPerSet: [21, 21, 11], setsToWin: 2 }
    });

    expect(snapshot).toMatchObject({ status: "Final", currentSet: 3, teamASets: 2, teamBSets: 1 });
    expect(snapshot.setScores.at(-1)).toEqual({ setNumber: 3, teamAScore: 11, teamBScore: 9, isComplete: true });
  });

  it("uses vMix teamName when players are structured arrays", () => {
    const payload = [
      { teamName: "Genny Cruz / Amaya Messier", isMatch: false, game1: 0, game2: 0, game3: 0, players: [{ firstname: "Genny", lastname: "Cruz" }] },
      { teamName: "Gella Andrew / Jordan Boulware", isMatch: false, game1: 0, game2: 0, game3: 0, players: [{ firstname: "Jordan", lastname: "Boulware" }] }
    ];
    const snapshot = normalizeScorePayload(payload);

    expect(snapshot.teamAName).toBe("Genny Cruz / Amaya Messier");
    expect(snapshot.teamBName).toBe("Gella Andrew / Jordan Boulware");
    expect(snapshot.status).toBe("Pre-Match");
    expect(isAuthoritativeScorePayload(payload, snapshot)).toBe(false);
  });

  it("treats nonzero vMix scores as authoritative", () => {
    const payload = [
      { teamName: "Alpha", isMatch: false, game1: 1, game2: 0, game3: 0 },
      { teamName: "Bravo", isMatch: false, game1: 0, game2: 0, game3: 0 }
    ];
    const snapshot = normalizeScorePayload(payload);

    expect(isAuthoritativeScorePayload(payload, snapshot)).toBe(true);
  });

  it("distinguishes a completed match from a completed set in object payloads", () => {
    const completedMatch = normalizeScorePayload({
      status: "Completed",
      setNumber: 1,
      score: { home: 28, away: 24 }
    }, { format: { bestOf: 1, pointsPerSet: [28], setsToWin: 1 } });
    const completedSet = normalizeScorePayload({
      status: "Set Complete",
      setNumber: 1,
      score: { home: 21, away: 18 }
    });

    expect(completedMatch).toMatchObject({ status: "Completed", teamASets: 1, teamBSets: 0 });
    expect(completedMatch.setScores[0].isComplete).toBe(true);
    expect(completedSet).toMatchObject({ status: "Set Complete", teamASets: 0, teamBSets: 0 });
  });

  it("does not treat completed set entry as active live scoring by itself", () => {
    const payload = [
      { teamName: "Alpha", isMatch: true, game1: 21, game2: 0, game3: 0 },
      { teamName: "Bravo", isMatch: true, game1: 18, game2: 0, game3: 0 }
    ];
    const snapshot = normalizeScorePayload(payload, {
      format: { bestOf: 3, pointsPerSet: [21, 21, 15], setsToWin: 2 }
    });

    expect(snapshot.status).toBe("In Progress");
    expect(snapshot.currentSet).toBe(2);
    expect(snapshot.teamASets).toBe(1);
    expect(snapshot.teamAScore).toBe(0);
    expect(snapshot.teamBScore).toBe(0);
    expect(isAuthoritativeScorePayload(payload, snapshot)).toBe(false);
  });

  it("treats completed match vMix scores as authoritative so final points are released", () => {
    const payload = [
      { teamName: "Alpha", isMatch: true, game1: 12, game2: 14, game3: 0 },
      { teamName: "Bravo", isMatch: true, game1: 21, game2: 21, game3: 0 }
    ];
    const snapshot = normalizeScorePayload(payload, {
      format: { bestOf: 3, pointsPerSet: [21, 21, 15], setsToWin: 2 }
    });

    expect(snapshot.status).toBe("Final");
    expect(snapshot.teamAScore).toBe(14);
    expect(snapshot.teamBScore).toBe(21);
    expect(snapshot.teamBSets).toBe(2);
    expect(isAuthoritativeScorePayload(payload, snapshot)).toBe(true);
  });

  it("trims duplicated vMix post-clinch set scores after a straight-sets final", () => {
    const payload = [
      { teamName: "Renata Lechien / Margaret Riley", isMatch: true, game1: 21, game2: 21, game3: 21 },
      { teamName: "Julia Anisimova / Wynter Thorne-Thomsen", isMatch: true, game1: 15, game2: 19, game3: 19 }
    ];
    const snapshot = normalizeScorePayload(payload, {
      format: { bestOf: 3, pointsPerSet: [21, 21, 15], setsToWin: 2 }
    });

    expect(snapshot.status).toBe("Final");
    expect(snapshot.currentSet).toBe(2);
    expect(snapshot.teamAScore).toBe(21);
    expect(snapshot.teamBScore).toBe(19);
    expect(snapshot.teamASets).toBe(2);
    expect(snapshot.teamBSets).toBe(0);
    expect(snapshot.setScores).toEqual([
      { setNumber: 1, teamAScore: 21, teamBScore: 15, isComplete: true },
      { setNumber: 2, teamAScore: 21, teamBScore: 19, isComplete: true }
    ]);
  });

  it("does not treat a started all-zero vMix match as live scoring", () => {
    const payload = [
      { teamName: "Alpha", isMatch: true, game1: 0, game2: 0, game3: 0 },
      { teamName: "Bravo", isMatch: true, game1: 0, game2: 0, game3: 0 }
    ];
    const snapshot = normalizeScorePayload(payload);

    expect(snapshot.status).toBe("In Progress");
    expect(isAuthoritativeScorePayload(payload, snapshot)).toBe(false);
  });

  it("uses bracket game scores as final confirmation when vMix never went live", () => {
    const snapshot = normalizeVblBracketPayload({
      games: [
        { number: 1, home: 21, away: 14, isFinal: false, dtModified: "1783100000000" },
        { number: 2, home: 21, away: 18, isFinal: false, dtModified: "1783101000000" },
        { number: 3, home: 0, away: 0, isFinal: false, dtModified: null }
      ]
    }, {
      team_a: "Kyle Paulson / Jack Walmer",
      team_b: "Richard Diedrich / Alex Mortimer",
      format: { bestOf: 3, pointsPerSet: [21, 21, 15], setsToWin: 2 }
    });

    expect(snapshot).toMatchObject({
      status: "Final",
      teamAScore: 21,
      teamBScore: 18,
      teamASets: 2,
      teamBSets: 0,
      teamAName: "Kyle Paulson / Jack Walmer",
      teamBName: "Richard Diedrich / Alex Mortimer"
    });
  });

  it("uses the configured deciding-set target in bracket confirmation", () => {
    const snapshot = normalizeVblBracketPayload({
      games: [
        { number: 1, home: 21, away: 18, isFinal: false },
        { number: 2, home: 18, away: 21, isFinal: false },
        { number: 3, home: 11, away: 9, isFinal: false }
      ]
    }, {
      format: { bestOf: 3, pointsPerSet: [21, 21, 11], setsToWin: 2 }
    });

    expect(snapshot).toMatchObject({ status: "Final", currentSet: 3, teamASets: 2, teamBSets: 1 });
    expect(snapshot?.setScores.at(-1)).toEqual({ setNumber: 3, teamAScore: 11, teamBScore: 9, isComplete: true });
  });

  it("ignores unused all-zero bracket games after a two-set final", () => {
    const snapshot = normalizeVblBracketPayload({
      games: [
        { number: 1, home: 12, away: 21, isFinal: true, dtModified: "1783100000000" },
        { number: 2, home: 15, away: 21, isFinal: true, dtModified: "1783101000000" },
        { number: 3, home: 0, away: 0, isFinal: true, dtModified: "1783102000000" }
      ]
    }, {
      team_a: "Connor Boyles / Jeff Bunge",
      team_b: "Ford Harman / Ian Satterfield",
      format: { bestOf: 3, pointsPerSet: [21, 21, 15], setsToWin: 2 }
    });

    expect(snapshot).toMatchObject({
      status: "Final",
      currentSet: 2,
      teamAScore: 15,
      teamBScore: 21,
      teamASets: 0,
      teamBSets: 2
    });
    expect(snapshot?.setScores).toEqual([
      { setNumber: 1, teamAScore: 12, teamBScore: 21, isComplete: true },
      { setNumber: 2, teamAScore: 15, teamBScore: 21, isComplete: true }
    ]);
  });

  it("trims duplicated bracket post-clinch set scores after a straight-sets final", () => {
    const snapshot = normalizeVblBracketPayload({
      games: [
        { number: 1, home: 21, away: 15, isFinal: true, dtModified: "1783100000000" },
        { number: 2, home: 21, away: 19, isFinal: true, dtModified: "1783101000000" },
        { number: 3, home: 21, away: 19, isFinal: true, dtModified: "1783102000000" }
      ]
    }, {
      team_a: "Renata Lechien / Margaret Riley",
      team_b: "Julia Anisimova / Wynter Thorne-Thomsen",
      format: { bestOf: 3, pointsPerSet: [21, 21, 15], setsToWin: 2 }
    });

    expect(snapshot).toMatchObject({
      status: "Final",
      currentSet: 2,
      teamAScore: 21,
      teamBScore: 19,
      teamASets: 2,
      teamBSets: 0
    });
    expect(snapshot?.setScores).toEqual([
      { setNumber: 1, teamAScore: 21, teamBScore: 15, isComplete: true },
      { setNumber: 2, teamAScore: 21, teamBScore: 19, isComplete: true }
    ]);
  });

  it("does not treat a single bracket set confirmation as match final", () => {
    const snapshot = normalizeVblBracketPayload({
      games: [
        { number: 1, home: 21, away: 19, isFinal: false, dtModified: "1783100000000" },
        { number: 2, home: 0, away: 0, isFinal: false, dtModified: null }
      ]
    }, {
      team_a: "Alpha",
      team_b: "Bravo",
      format: { bestOf: 3, pointsPerSet: [21, 21, 15], setsToWin: 2 }
    });

    expect(snapshot).toMatchObject({
      status: "In Progress",
      teamASets: 1,
      teamBSets: 0
    });
  });

  it("discovers future bracket placeholders and event-local schedule text", () => {
    const matches = discoverMatchesFromHydrate({
      teams: [
        { id: 11, name: "Known Team / Player Two", seed: 1, players: [{ name: "Known Team" }, { name: "Player Two" }] }
      ],
      days: [{
        id: 287192,
        brackets: [{
          name: "Playoffs",
          type: "SINGLE_ELIM",
          winnersMatchSettings: { gameSettings: [{ to: 21, cap: 23 }, { to: 21, cap: 23 }, { to: 15, cap: 17 }] },
          matches: [
            {
              id: 387628,
              displayNumber: 13,
              number: 114,
              court: "8",
              startTime: "2026-07-03T12:00:00Z",
              homeTeam: null,
              awayTeam: null,
              homeMap: "Match 2 Winner",
              awayMap: "Match 3 Winner",
              homeSeed: 0,
              awaySeed: 0,
              isBye: false
            },
            {
              id: 999,
              displayNumber: 0,
              number: 101,
              court: null,
              startTime: null,
              homeTeam: { teamId: 11, seed: 1 },
              awayTeam: null,
              homeMap: "1",
              awayMap: "Bye",
              homeSeed: 1,
              awaySeed: 0,
              isBye: false
            }
          ]
        }]
      }]
    }, "https://volleyballlife.com/event/37451/division/136904/round/287192/brackets");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      externalMatchId: "387628",
      matchNumber: "13",
      courtNumber: "8",
      scheduledDate: "Fri 2026-07-03",
      scheduledTime: "12:00 PM",
      teamA: "Winner of Match 2",
      teamB: "Winner of Match 3",
      teamASeed: null,
      teamBSeed: null,
      apiUrl: "https://api.volleyballlife.com/api/v1.0/matches/387628/vmix?bracket=true"
    });
  });
});
