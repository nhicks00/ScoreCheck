import { ScoreSnapshot, SetScore } from "./types";

type MatchLike = {
  team_a?: string | null;
  team_b?: string | null;
  team_a_seed?: string | null;
  team_b_seed?: string | null;
  format?: Record<string, unknown> | null;
};

export function normalizeScorePayload(payload: unknown, match?: MatchLike | null): ScoreSnapshot {
  if (Array.isArray(payload)) {
    return normalizeArrayPayload(payload, match);
  }
  if (payload && typeof payload === "object") {
    return normalizeObjectPayload(payload as Record<string, unknown>, match);
  }
  return emptySnapshot(match);
}

function normalizeArrayPayload(payload: unknown[], match?: MatchLike | null): ScoreSnapshot {
  const teamA = recordAt(payload, 0);
  const teamB = recordAt(payload, 1);
  if (!teamA || !teamB) return emptySnapshot(match);

  const format = parseFormat(match?.format);
  const games = [1, 2, 3].map((setNumber) => {
    const a = safeScore(teamA[`game${setNumber}`]);
    const b = safeScore(teamB[`game${setNumber}`]);
    return { setNumber, teamAScore: a, teamBScore: b };
  });

  const setScores: SetScore[] = [];
  let teamASets = 0;
  let teamBSets = 0;
  for (const game of games) {
    if (game.teamAScore === 0 && game.teamBScore === 0 && setScores.length === 0) continue;
    if (game.teamAScore === 0 && game.teamBScore === 0) break;
    const target = game.setNumber === 3 ? Math.min(format.pointsPerSet[0] ?? 21, 15) : (format.pointsPerSet[game.setNumber - 1] ?? format.pointsPerSet[0] ?? 21);
    const isComplete = isSetComplete(game.teamAScore, game.teamBScore, target, format.cap);
    setScores.push({ ...game, isComplete });
    if (isComplete) {
      if (game.teamAScore > game.teamBScore) teamASets += 1;
      if (game.teamBScore > game.teamAScore) teamBSets += 1;
    }
  }

  const current = setScores.at(-1);
  const won = teamASets >= format.setsToWin || teamBSets >= format.setsToWin;
  const status = won ? "Final" : setScores.length > 0 ? "In Progress" : "Pre-Match";

  return {
    status,
    currentSet: current?.isComplete ? setScores.length + 1 : Math.max(setScores.length, 1),
    teamAName: cleanText(teamA.players) ?? cleanText(teamA.teamName) ?? match?.team_a ?? "Team A",
    teamBName: cleanText(teamB.players) ?? cleanText(teamB.teamName) ?? match?.team_b ?? "Team B",
    teamASeed: cleanText(teamA.seed) ?? match?.team_a_seed ?? null,
    teamBSeed: cleanText(teamB.seed) ?? match?.team_b_seed ?? null,
    teamAScore: current?.teamAScore ?? 0,
    teamBScore: current?.teamBScore ?? 0,
    teamASets,
    teamBSets,
    servingTeam: null,
    setScores,
    source: "api",
    stale: false,
    message: null
  };
}

function normalizeObjectPayload(payload: Record<string, unknown>, match?: MatchLike | null): ScoreSnapshot {
  const score = record(payload.score);
  const teamAScore = safeScore(score?.home);
  const teamBScore = safeScore(score?.away);
  const status = cleanText(payload.status) ?? (teamAScore || teamBScore ? "In Progress" : "Pre-Match");
  const currentSet = numberValue(payload.setNumber) ?? 1;
  const isFinal = status.toLowerCase().includes("final");
  const setScores = teamAScore || teamBScore
    ? [{ setNumber: currentSet, teamAScore, teamBScore, isComplete: isFinal }]
    : [];

  return {
    status,
    currentSet,
    teamAName: cleanText(payload.team1_text) ?? cleanText(payload.homeTeam) ?? cleanText(payload.team1Name) ?? match?.team_a ?? "Team A",
    teamBName: cleanText(payload.team2_text) ?? cleanText(payload.awayTeam) ?? cleanText(payload.team2Name) ?? match?.team_b ?? "Team B",
    teamASeed: cleanText(payload.seed1) ?? match?.team_a_seed ?? null,
    teamBSeed: cleanText(payload.seed2) ?? match?.team_b_seed ?? null,
    teamAScore,
    teamBScore,
    teamASets: isFinal && teamAScore > teamBScore ? 1 : 0,
    teamBSets: isFinal && teamBScore > teamAScore ? 1 : 0,
    servingTeam: cleanText(payload.serve) === "home" ? "A" : cleanText(payload.serve) === "away" ? "B" : null,
    setScores,
    source: "api",
    stale: false,
    message: null
  };
}

function emptySnapshot(match?: MatchLike | null): ScoreSnapshot {
  return {
    status: "Pre-Match",
    currentSet: 1,
    teamAName: match?.team_a ?? "Team A",
    teamBName: match?.team_b ?? "Team B",
    teamASeed: match?.team_a_seed ?? null,
    teamBSeed: match?.team_b_seed ?? null,
    teamAScore: 0,
    teamBScore: 0,
    teamASets: 0,
    teamBSets: 0,
    servingTeam: null,
    setScores: [],
    source: "api",
    stale: false,
    message: null
  };
}

export function isSetComplete(a: number, b: number, target: number, cap: number | null): boolean {
  const max = Math.max(a, b);
  if (cap && max >= cap) return true;
  return max >= target && Math.abs(a - b) >= 2;
}

function parseFormat(format?: Record<string, unknown> | null) {
  const bestOf = numberValue(format?.bestOf) ?? 3;
  return {
    pointsPerSet: Array.isArray(format?.pointsPerSet)
      ? format.pointsPerSet.map(numberValue).filter((value): value is number => value != null)
      : [21],
    cap: numberValue(format?.cap),
    setsToWin: numberValue(format?.setsToWin) ?? Math.ceil(bestOf / 2)
  };
}

function recordAt(values: unknown[], index: number): Record<string, unknown> | null {
  return record(values[index]);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function cleanText(value: unknown): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function numberValue(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function safeScore(value: unknown): number {
  const parsed = numberValue(value) ?? 0;
  return parsed >= 60 ? Math.abs(parsed) % 10 : parsed;
}
