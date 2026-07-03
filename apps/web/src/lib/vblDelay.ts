import type { ScoreSnapshot } from "./types";

export const VBL_OVERLAY_DELAY_MS = 6_000;

export type DelayedVblScorePayload = {
  match_id: string;
  team_a_score: number;
  team_b_score: number;
  team_a_sets: number;
  team_b_sets: number;
  current_set: number;
  set_scores: unknown;
  serving_team: "A" | "B" | null;
  status: string;
};

export type DelayedVblScore = {
  key: string;
  capturedAt: string;
  visibleAt: string;
  score: DelayedVblScorePayload;
};

export type VisibleScoreLike = {
  match_id?: string | null;
  matchId?: string | null;
  team_a_score?: number | null;
  teamAScore?: number | null;
  team_b_score?: number | null;
  teamBScore?: number | null;
  team_a_sets?: number | null;
  teamASets?: number | null;
  team_b_sets?: number | null;
  teamBSets?: number | null;
  current_set?: number | null;
  currentSet?: number | null;
  set_scores?: unknown;
  setScores?: unknown;
  serving_team?: string | null;
  servingTeam?: string | null;
  status?: string | null;
};

export function delayedScoreFromSnapshot(matchId: string, snapshot: ScoreSnapshot, capturedAt: string, delayMs = VBL_OVERLAY_DELAY_MS): DelayedVblScore {
  const score: DelayedVblScorePayload = {
    match_id: matchId,
    team_a_score: snapshot.teamAScore,
    team_b_score: snapshot.teamBScore,
    team_a_sets: snapshot.teamASets,
    team_b_sets: snapshot.teamBSets,
    current_set: snapshot.currentSet,
    set_scores: snapshot.setScores,
    serving_team: snapshot.servingTeam ?? null,
    status: snapshot.status
  };
  return {
    key: scoreKey(score),
    capturedAt,
    visibleAt: new Date(new Date(capturedAt).getTime() + delayMs).toISOString(),
    score
  };
}

export function queueDelayedVblScore(rawPending: unknown, visibleScore: VisibleScoreLike | null | undefined, next: DelayedVblScore, maxQueueLength = 12) {
  const visibleKey = visibleScore ? scoreKeyFromVisible(visibleScore) : null;
  const existing = parsePendingScores(rawPending);
  if (next.key === visibleKey || existing.some((item) => item.key === next.key)) {
    return existing;
  }
  return [...existing, next]
    .sort((a, b) => Date.parse(a.visibleAt) - Date.parse(b.visibleAt))
    .slice(-maxQueueLength);
}

export function splitDueDelayedVblScores(rawPending: unknown, now: string) {
  const pending = parsePendingScores(rawPending);
  const nowMs = Date.parse(now);
  const due = pending.filter((item) => Date.parse(item.visibleAt) <= nowMs);
  const remaining = pending.filter((item) => Date.parse(item.visibleAt) > nowMs);
  return {
    latestDue: due.sort((a, b) => Date.parse(a.visibleAt) - Date.parse(b.visibleAt)).at(-1) ?? null,
    remaining
  };
}

export function pendingScoresForMatch(rawPending: unknown, matchId: string) {
  return parsePendingScores(rawPending).filter((item) => item.score.match_id === matchId);
}

export function parsePendingScores(value: unknown): DelayedVblScore[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const score = record.score;
      if (!score || typeof score !== "object" || Array.isArray(score)) return null;
      const parsedScore = parseScore(score as Record<string, unknown>);
      const capturedAt = stringValue(record.capturedAt);
      const visibleAt = stringValue(record.visibleAt);
      if (!parsedScore || !capturedAt || !visibleAt || !Number.isFinite(Date.parse(visibleAt))) return null;
      return {
        key: stringValue(record.key) ?? scoreKey(parsedScore),
        capturedAt,
        visibleAt,
        score: parsedScore
      };
    })
    .filter((item): item is DelayedVblScore => Boolean(item));
}

function scoreKeyFromVisible(score: VisibleScoreLike) {
  return scoreKey({
    match_id: stringValue(score.match_id ?? score.matchId) ?? "",
    team_a_score: numberValue(score.team_a_score ?? score.teamAScore),
    team_b_score: numberValue(score.team_b_score ?? score.teamBScore),
    team_a_sets: numberValue(score.team_a_sets ?? score.teamASets),
    team_b_sets: numberValue(score.team_b_sets ?? score.teamBSets),
    current_set: numberValue(score.current_set ?? score.currentSet) || 1,
    set_scores: score.set_scores ?? score.setScores ?? [],
    serving_team: servingTeamValue(score.serving_team ?? score.servingTeam),
    status: stringValue(score.status) ?? ""
  });
}

function parseScore(score: Record<string, unknown>): DelayedVblScorePayload | null {
  const matchId = stringValue(score.match_id);
  const status = stringValue(score.status);
  if (!matchId || !status) return null;
  return {
    match_id: matchId,
    team_a_score: numberValue(score.team_a_score),
    team_b_score: numberValue(score.team_b_score),
    team_a_sets: numberValue(score.team_a_sets),
    team_b_sets: numberValue(score.team_b_sets),
    current_set: numberValue(score.current_set) || 1,
    set_scores: Array.isArray(score.set_scores) ? score.set_scores : [],
    serving_team: servingTeamValue(score.serving_team),
    status
  };
}

function scoreKey(score: DelayedVblScorePayload) {
  return JSON.stringify({
    match_id: score.match_id,
    team_a_score: score.team_a_score,
    team_b_score: score.team_b_score,
    team_a_sets: score.team_a_sets,
    team_b_sets: score.team_b_sets,
    current_set: score.current_set,
    set_scores: score.set_scores,
    serving_team: score.serving_team,
    status: score.status
  });
}

function stringValue(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length ? text : null;
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function servingTeamValue(value: unknown): "A" | "B" | null {
  return value === "A" || value === "B" ? value : null;
}
