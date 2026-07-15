type MatchSourceLike = {
  api_url?: string | null;
  apiUrl?: string | null;
  source_type?: string | null;
  sourceType?: string | null;
} | null;

type ScoreSourceLike = Record<string, unknown> | null | undefined;

export function apiScoreHasPriority(score: ScoreSourceLike, match: MatchSourceLike): boolean {
  // An operator correction is an explicit source lock. It remains authoritative
  // until another audited command clears the override; community and provider
  // writers must never infer that the lock has expired from score shape alone.
  if (score?.source === "override" || score?.source_priority === "override" || score?.sourcePriority === "override") {
    return true;
  }
  const apiUrl = match?.api_url ?? match?.apiUrl;
  const sourceType = match?.source_type ?? match?.sourceType;
  if (!apiUrl || sourceType === "manual") return false;
  if (!score || score.source !== "api" || score.stale === true) return false;
  if (score.source_available === false || score.sourceAvailable === false) return false;
  if (score.source_priority === "fallback" || score.sourcePriority === "fallback") return false;
  return scoreLooksLive(score);
}

function scoreLooksLive(score: Record<string, unknown>): boolean {
  const status = stringValue(score.status).toLowerCase();
  if (numberValue(score.team_a_score ?? score.teamAScore) > 0 || numberValue(score.team_b_score ?? score.teamBScore) > 0) return true;
  if (status.includes("final")) return false;
  const setScores = score.set_scores ?? score.setScores;
  if (Array.isArray(setScores) && setScores.some(isActiveSetScore)) return true;
  if (status.includes("progress")) {
    return !Array.isArray(setScores) || setScores.length === 0;
  }
  return false;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function numberValue(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function isActiveSetScore(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.isComplete === true) return false;
  return numberValue(record.teamAScore ?? record.team_a_score) > 0 || numberValue(record.teamBScore ?? record.team_b_score) > 0;
}
