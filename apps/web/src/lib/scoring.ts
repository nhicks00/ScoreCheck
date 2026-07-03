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

export function isAuthoritativeScorePayload(payload: unknown, snapshot: ScoreSnapshot): boolean {
  if (Array.isArray(payload)) {
    return vMixArrayHasLiveScoring(payload, snapshot);
  }
  return scoreSnapshotHasLiveScore(snapshot);
}

export function normalizeVblBracketPayload(payload: unknown, match?: MatchLike | null): ScoreSnapshot | null {
  const source = record(payload);
  const games = arrayOfRecords(source?.games)
    .map((game) => ({
      setNumber: numberValue(game.number) ?? 1,
      teamAScore: safeScore(game.home),
      teamBScore: safeScore(game.away),
      explicitFinal: game.isFinal === true
    }))
    .sort((a, b) => a.setNumber - b.setNumber);
  if (!games.length) return null;

  const format = parseFormat(match?.format);
  const setScores: SetScore[] = [];
  let teamASets = 0;
  let teamBSets = 0;
  for (const game of games) {
    const hasScore = game.teamAScore > 0 || game.teamBScore > 0;
    if (!hasScore) continue;
    const target = game.setNumber === 3 ? Math.min(format.pointsPerSet[0] ?? 21, 15) : (format.pointsPerSet[game.setNumber - 1] ?? format.pointsPerSet[0] ?? 21);
    const isComplete = game.explicitFinal || isSetComplete(game.teamAScore, game.teamBScore, target, format.cap);
    setScores.push({
      setNumber: game.setNumber,
      teamAScore: game.teamAScore,
      teamBScore: game.teamBScore,
      isComplete
    });
    if (isComplete) {
      if (game.teamAScore > game.teamBScore) teamASets += 1;
      if (game.teamBScore > game.teamAScore) teamBSets += 1;
    }
  }

  if (!setScores.length) return null;

  const won = teamASets >= format.setsToWin || teamBSets >= format.setsToWin;
  const finalSetScores = won ? trimSetScoresAtClinch(setScores, format.setsToWin) : setScores;
  const finalCounts = won ? setWinCounts(finalSetScores) : { teamASets, teamBSets };
  const activeSet = finalSetScores.find((set) => !set.isComplete) ?? null;
  const displaySet = won ? finalSetScores.at(-1) : activeSet;
  return {
    status: won ? "Final" : "In Progress",
    currentSet: won ? Math.max(displaySet?.setNumber ?? finalSetScores.length, 1) : activeSet?.setNumber ?? Math.min(finalSetScores.length + 1, format.bestOf),
    teamAName: match?.team_a ?? "Team A",
    teamBName: match?.team_b ?? "Team B",
    teamASeed: match?.team_a_seed ?? null,
    teamBSeed: match?.team_b_seed ?? null,
    teamAScore: displaySet?.teamAScore ?? 0,
    teamBScore: displaySet?.teamBScore ?? 0,
    teamASets: finalCounts.teamASets,
    teamBSets: finalCounts.teamBSets,
    servingTeam: null,
    setScores: finalSetScores,
    source: "api",
    stale: false,
    message: null
  };
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

  const activeSet = setScores.find((set) => !set.isComplete) ?? null;
  const finalSet = setScores.at(-1) ?? null;
  const won = teamASets >= format.setsToWin || teamBSets >= format.setsToWin;
  const finalSetScores = won ? trimSetScoresAtClinch(setScores, format.setsToWin) : setScores;
  const finalCounts = won ? setWinCounts(finalSetScores) : { teamASets, teamBSets };
  const displaySet = won ? finalSetScores.at(-1) ?? finalSet : activeSet;
  const currentSet = won ? Math.max(displaySet?.setNumber ?? finalSetScores.length, 1) : activeSet?.setNumber ?? Math.min(finalSetScores.length + 1, format.bestOf);
  const scoringStarted = teamA.isMatch === true || teamB.isMatch === true || setScores.length > 0;
  const status = won ? "Final" : scoringStarted ? "In Progress" : "Pre-Match";

  return {
    status,
    currentSet,
    teamAName: cleanText(teamA.teamName) ?? teamNameFromPayload(teamA.players) ?? match?.team_a ?? "Team A",
    teamBName: cleanText(teamB.teamName) ?? teamNameFromPayload(teamB.players) ?? match?.team_b ?? "Team B",
    teamASeed: cleanText(teamA.seed) ?? match?.team_a_seed ?? null,
    teamBSeed: cleanText(teamB.seed) ?? match?.team_b_seed ?? null,
    teamAScore: displaySet?.teamAScore ?? 0,
    teamBScore: displaySet?.teamBScore ?? 0,
    teamASets: finalCounts.teamASets,
    teamBSets: finalCounts.teamBSets,
    servingTeam: null,
    setScores: finalSetScores,
    source: "api",
    stale: false,
    message: null
  };
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
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

function trimSetScoresAtClinch(setScores: SetScore[], setsToWin: number) {
  const orderedSets = [...setScores].sort((a, b) => a.setNumber - b.setNumber);
  const trimmed: SetScore[] = [];
  let teamASets = 0;
  let teamBSets = 0;

  for (const set of orderedSets) {
    trimmed.push(set);
    if (set.isComplete && set.teamAScore > set.teamBScore) teamASets += 1;
    if (set.isComplete && set.teamBScore > set.teamAScore) teamBSets += 1;
    if (teamASets >= setsToWin || teamBSets >= setsToWin) break;
  }

  return trimmed;
}

function setWinCounts(setScores: SetScore[]) {
  return setScores.reduce((counts, set) => {
    if (set.isComplete && set.teamAScore > set.teamBScore) counts.teamASets += 1;
    if (set.isComplete && set.teamBScore > set.teamAScore) counts.teamBSets += 1;
    return counts;
  }, { teamASets: 0, teamBSets: 0 });
}

function parseFormat(format?: Record<string, unknown> | null) {
  const bestOf = numberValue(format?.bestOf) ?? 3;
  return {
    bestOf,
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
  if (Array.isArray(value)) return null;
  if (value == null) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function teamNameFromPayload(value: unknown): string | null {
  if (typeof value === "string") return cleanText(value);
  if (!Array.isArray(value)) return null;
  const names = value.map((player) => {
    const record = player && typeof player === "object" && !Array.isArray(player) ? player as Record<string, unknown> : null;
    if (!record) return null;
    const first = cleanText(record.firstname);
    const last = cleanText(record.lastname);
    return [first, last].filter(Boolean).join(" ").trim() || cleanText(record.name);
  }).filter((name): name is string => Boolean(name));
  return names.length ? names.join(" / ") : null;
}

function vMixArrayHasLiveScoring(payload: unknown[], snapshot: ScoreSnapshot): boolean {
  const rows = payload.map(record).filter((row): row is Record<string, unknown> => Boolean(row));
  const hasStartedMatch = rows.some((row) => row.isMatch === true);
  const hasAnyPoint = rows.some((row) => [1, 2, 3, 4, 5].some((setNumber) => safeScore(row[`game${setNumber}`]) > 0));
  const hasActiveSetScore = snapshot.setScores.some((set) => !set.isComplete && (set.teamAScore > 0 || set.teamBScore > 0));
  const hasFinalScore = snapshot.status.toLowerCase().includes("final") && snapshot.setScores.some((set) => set.isComplete);

  if (hasActiveSetScore) return true;
  if (hasFinalScore) return true;
  if (hasStartedMatch && !hasAnyPoint) return true;
  return false;
}

function scoreSnapshotHasLiveScore(snapshot: ScoreSnapshot): boolean {
  if (snapshot.teamAScore > 0 || snapshot.teamBScore > 0) return true;
  if (snapshot.setScores.some((set) => !set.isComplete && (set.teamAScore > 0 || set.teamBScore > 0))) return true;
  const status = snapshot.status.toLowerCase();
  if (status.includes("final")) return false;
  if (status.includes("progress")) {
    return snapshot.setScores.length === 0 && snapshot.teamASets === 0 && snapshot.teamBSets === 0;
  }
  return false;
}

function numberValue(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function safeScore(value: unknown): number {
  const parsed = numberValue(value) ?? 0;
  return parsed >= 60 ? Math.abs(parsed) % 10 : parsed;
}
