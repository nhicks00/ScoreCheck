type PortalScoreLike = {
  teamAScore?: number | null;
  teamBScore?: number | null;
  teamASets?: number | null;
  teamBSets?: number | null;
  setScores?: Array<{
    teamAScore?: number | null;
    teamBScore?: number | null;
  }> | null;
  status?: string | null;
} | null | undefined;

export function isActivelyPlayingScore(score: PortalScoreLike) {
  if (!score) return false;
  const status = score.status?.trim().toLowerCase() ?? "";
  if (isFinalScoreStatus(status)) return false;
  if (status.includes("pre-match") || status.includes("prematch") || status.includes("waiting")) return false;
  if (status.includes("progress") || status.includes("live") || status.includes("set complete")) return true;

  return positive(score.teamAScore)
    || positive(score.teamBScore)
    || positive(score.teamASets)
    || positive(score.teamBSets)
    || Boolean(score.setScores?.some((set) => positive(set.teamAScore) || positive(set.teamBScore)));
}

export function isFinalScoreStatus(value: unknown) {
  if (typeof value !== "string") return false;
  const status = value.trim().toLowerCase();
  return status.includes("final")
    || status.includes("finished")
    || (status.includes("complete") && !status.includes("set complete"));
}

function positive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}
