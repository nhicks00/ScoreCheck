type UnknownRow = Record<string, unknown>;

export type PublicEventSummaryDto = {
  name: string;
  slug: string | null;
};

export type PublicEventDetailDto = PublicEventSummaryDto & {
  id: string;
};

export type PublicScorerStatusDto = {
  needsScorer: boolean;
  backupRequested: boolean;
  hasActive: boolean;
  backupCount: number;
  activeName: string | null;
};

export type PublicSetScoreDto = {
  setNumber: number;
  teamAScore: number;
  teamBScore: number;
  isComplete: boolean;
};

export function publicCourtCoverage(input: {
  scoringOpen: unknown;
  hasMatch: unknown;
  authorityMode: unknown;
}): Pick<PublicScorerStatusDto, "needsScorer" | "hasActive"> {
  const scoringOpen = input.scoringOpen !== false;
  const hasMatch = input.hasMatch === true;
  const authorityMode = typeof input.authorityMode === "string" ? input.authorityMode : null;
  const coveredAuthority = authorityMode != null && authorityMode !== "PAUSED_DISPUTE";
  return {
    needsScorer: scoringOpen && hasMatch && !coveredAuthority,
    hasActive: scoringOpen && hasMatch && coveredAuthority
  };
}

/**
 * Public API DTOs are deliberately assembled property-by-property. Database
 * rows passed to these helpers may contain credentials, hashes, infrastructure
 * identifiers, or future private columns; object spreading is forbidden here.
 */
export function toPublicEventSummaryDto(value: unknown): PublicEventSummaryDto {
  const row = record(value);
  return {
    name: text(row.name) ?? "Event",
    slug: text(row.slug)
  };
}

export function toPublicEventDetailDto(value: unknown): PublicEventDetailDto {
  const row = record(value);
  return {
    id: text(row.id) ?? "",
    ...toPublicEventSummaryDto(row)
  };
}

export function toPublicScorerStatusDto(input: {
  needsScorer: unknown;
  backupRequested: unknown;
  hasActive: unknown;
  backupCount: unknown;
  activeName: unknown;
}): PublicScorerStatusDto {
  return {
    needsScorer: input.needsScorer === true,
    backupRequested: input.backupRequested === true,
    hasActive: input.hasActive === true,
    backupCount: nonNegativeInteger(input.backupCount),
    activeName: text(input.activeName, 80)
  };
}

export function toPublicCourtDetailDto(input: {
  event: unknown;
  court: unknown;
  match: unknown | null;
  score: unknown | null;
  scorerStatus: PublicScorerStatusDto;
}) {
  const court = record(input.court);
  const match = input.match ? record(input.match) : null;
  const score = input.score ? record(input.score) : null;
  return {
    event: toPublicEventDetailDto(input.event),
    court: {
      id: text(court.id) ?? "",
      court_number: nonNegativeInteger(court.court_number),
      display_name: text(court.display_name) ?? "Court",
      scoring_open: court.scoring_open !== false
    },
    match: match ? {
      id: text(match.id) ?? "",
      team_a: text(match.team_a),
      team_b: text(match.team_b),
      round_name: text(match.round_name),
      match_number: text(match.match_number),
      status: text(match.status)
    } : null,
    score: score ? {
      team_a_score: nonNegativeInteger(score.team_a_score),
      team_b_score: nonNegativeInteger(score.team_b_score),
      current_set: positiveInteger(score.current_set),
      status: text(score.status) ?? "Prematch"
    } : null,
    scorerStatus: input.scorerStatus
  };
}

export function toPublicCourtCardDto(input: {
  court: unknown;
  match: unknown | null;
  score: unknown | null;
  scorerStatus: PublicScorerStatusDto;
}) {
  const court = record(input.court);
  const match = input.match ? record(input.match) : null;
  const score = input.score ? record(input.score) : null;
  return {
    id: text(court.id) ?? "",
    courtNumber: nonNegativeInteger(court.court_number),
    displayName: text(court.display_name) ?? "Court",
    scoringOpen: court.scoring_open !== false,
    lastUpdateAt: text(court.last_update_at),
    // YouTube video ids are intentionally public: they only identify the
    // already-public watch page and are not stream ingestion credentials.
    youtubeVideoId: text(court.youtube_video_id, 100),
    backupRequested: input.scorerStatus.backupRequested,
    scorerStatus: {
      needsScorer: input.scorerStatus.needsScorer,
      hasActive: input.scorerStatus.hasActive,
      backups: input.scorerStatus.backupCount,
      activeName: input.scorerStatus.activeName
    },
    match: match ? {
      id: text(match.id) ?? "",
      matchNumber: text(match.match_number),
      roundName: text(match.round_name),
      teamA: text(match.team_a),
      teamB: text(match.team_b)
    } : null,
    score: score ? {
      teamAScore: nonNegativeInteger(score.team_a_score),
      teamBScore: nonNegativeInteger(score.team_b_score),
      teamASets: nonNegativeInteger(score.team_a_sets),
      teamBSets: nonNegativeInteger(score.team_b_sets),
      currentSet: positiveInteger(score.current_set),
      setScores: publicSetScores(score.set_scores),
      status: text(score.status) ?? "Prematch",
      lastScoreChangeAt: text(score.last_score_change_at),
      updatedAt: text(score.updated_at)
    } : null
  };
}

function publicSetScores(value: unknown): PublicSetScoreDto[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 9).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as UnknownRow;
    return [{
      setNumber: positiveInteger(row.setNumber ?? row.set_number),
      teamAScore: nonNegativeInteger(row.teamAScore ?? row.team_a_score),
      teamBScore: nonNegativeInteger(row.teamBScore ?? row.team_b_score),
      isComplete: row.isComplete === true || row.is_complete === true
    }];
  });
}

function record(value: unknown): UnknownRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRow
    : {};
}

function text(value: unknown, maxLength = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function positiveInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 1;
}
