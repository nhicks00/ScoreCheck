type MatchSourceLike = {
  api_url?: string | null;
  apiUrl?: string | null;
  source_type?: string | null;
  sourceType?: string | null;
} | null;

type ScoreSourceLike = Record<string, unknown> | null | undefined;

export function apiScoreHasPriority(score: ScoreSourceLike, match: MatchSourceLike): boolean {
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
  if (status.includes("final") || status.includes("progress")) return true;
  if (numberValue(score.team_a_score ?? score.teamAScore) > 0 || numberValue(score.team_b_score ?? score.teamBScore) > 0) return true;
  if (numberValue(score.team_a_sets ?? score.teamASets) > 0 || numberValue(score.team_b_sets ?? score.teamBSets) > 0) return true;
  const setScores = score.set_scores ?? score.setScores;
  return Array.isArray(setScores) && setScores.length > 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function numberValue(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}
