export type TeamSide = "A" | "B";
export type CommunityRole = "OBSERVER" | "VERIFIED_WITNESS" | "DESIGNATED_SCORER";
export type AuthorityMode = "ADMIN_LOCKED" | "PROVIDER_PRIMARY" | "DESIGNATED_PRIMARY" | "VERIFIED_CONSENSUS" | "PAUSED_DISPUTE";
export type ContributionActionType = "ADD_POINT" | "REMOVE_POINT";

export type CommunityAssignment = {
  id: string;
  eventId: string;
  courtId: string;
  matchId: string;
  displayName: string;
  role: CommunityRole;
  trustTier: "REMOTE" | "COURTSIDE" | "VERIFIED_COURTSIDE";
  status: "ACTIVE" | "RELEASED" | "REVOKED" | "EXPIRED" | "MATCH_ENDED";
  authorityEpoch: number;
  leaseExpiresAt: string;
};

export type CommunityMatch = {
  id: string;
  eventId: string;
  courtId: string;
  courtNumber: number;
  courtName: string;
  teamAName: string;
  teamBName: string;
  matchNumber: string | null;
  roundName: string | null;
  format: Record<string, unknown>;
};

export type SetScore = {
  setNumber: number;
  teamAScore: number;
  teamBScore: number;
  isComplete: boolean;
};

export type CommunityScore = {
  revision: number;
  authorityEpoch: number;
  authorityMode: AuthorityMode;
  stateHash: string;
  teamAScore: number;
  teamBScore: number;
  teamASets: number;
  teamBSets: number;
  currentSet: number;
  setScores: SetScore[];
  servingTeam: TeamSide | null;
  timeouts: Record<string, unknown>;
  status: "Pre-Match" | "In Progress" | "Set Complete" | "Final";
  currentRallyNumber: number;
  updatedAt: string;
};

export type ContributionReceiptDto = {
  id: string;
  rallyNumber: number;
  status: "RECORDED" | "CONFIRMED" | "TRIGGERED_REVIEW" | "CONTRIBUTED_TO_CORRECTION" | "DIFFERED" | "LATE";
  message: string;
  canonicalRevision: number | null;
  resolvedAt: string | null;
};

export type CommunityRallyDto = {
  rallyNumber: number;
  status: "UNOBSERVED" | "CONFIRMED" | "DISPUTED" | "CORRECTED" | "VOIDED";
};

export type CommunityProjection = {
  currentRallyNumber: number;
  witnessCount: number;
  confirmedTogether: number;
  hasContributedToCurrentRevision: boolean;
  recentRallies: CommunityRallyDto[];
  latestReceipt: ContributionReceiptDto | null;
  personalSummary: {
    contributionsRecorded: number;
    confirmedCalls: number;
    reviewTriggers: number;
    correctionsHelped: number;
  };
};

export type CommunitySessionSnapshot = {
  ok: true;
  duplicate?: boolean;
  projectionStatus?: "NOT_REQUIRED" | "PUBLISHED" | "RETRYING";
  assignment: CommunityAssignment;
  match: CommunityMatch;
  score: CommunityScore;
  receipt: ContributionReceiptDto | null;
  community: CommunityProjection;
};

export type CommunityReceiptStatus =
  | "sending"
  | "retrying"
  | "recorded"
  | "confirmed"
  | "review"
  | "corrected"
  | "differed"
  | "late"
  | "offline"
  | "failed";

export type CommunityReceipt = {
  actionId?: string | null;
  rallyNumber: number | null;
  status: CommunityReceiptStatus;
  message: string;
};

export type CommunityRally = {
  rallyNumber: number;
  status: "broadcast" | "confirmed" | "corrected" | "pending" | "review" | "voided";
};

export type CommunityTeam = {
  id: TeamSide;
  name: string;
  score: number;
  setsWon: number;
  tone: "blue" | "red";
};

export type CommunityWitnessViewModel = {
  matchId: string;
  matchLabel: string;
  courtLabel: string;
  currentSet: number;
  isLive: boolean;
  isFinal: boolean;
  teams: Record<TeamSide, CommunityTeam>;
  currentRallyNumber: number;
  rallyJourney: CommunityRally[];
  coverageLabel: string;
  latestReceipt: CommunityReceipt | null;
  personalSummary: CommunityProjection["personalSummary"];
};

export const DEFAULT_SIDE_ORDER: readonly [TeamSide, TeamSide] = ["A", "B"];
export const COMMUNITY_FAST_SYNC_WINDOW_MS = 10_000;
export const COMMUNITY_MAX_AUTO_RETRIES = 5;

export type CommunityRetryPlan = {
  mode: "offline" | "scheduled" | "manual";
  retryAfterMs: number | null;
};

export function communitySyncDelayMs(input: { visible: boolean; fastUntil: number; now: number }): number {
  if (!input.visible) return 30_000;
  return input.fastUntil > input.now ? 2_000 : 8_000;
}

export function communitySyncJitterMs(assignmentId: string): number {
  let hash = 0;
  for (let index = 0; index < assignmentId.length; index += 1) {
    hash = (hash * 31 + assignmentId.charCodeAt(index)) >>> 0;
  }
  return hash % 750;
}

export function communityRetryPlan(failureCount: number, online: boolean): CommunityRetryPlan {
  if (!online) return { mode: "offline", retryAfterMs: null };
  const normalizedCount = Math.max(1, Math.round(failureCount));
  if (normalizedCount > COMMUNITY_MAX_AUTO_RETRIES) return { mode: "manual", retryAfterMs: null };
  return {
    mode: "scheduled",
    retryAfterMs: Math.min(16_000, 1_000 * (2 ** (normalizedCount - 1)))
  };
}

export function adaptCommunityWitnessState(snapshot: CommunitySessionSnapshot): CommunityWitnessViewModel {
  const latestReceipt = normalizeReceipt(snapshot.receipt ?? snapshot.community.latestReceipt);
  const receiptRally = latestReceipt?.rallyNumber ?? 0;
  const currentRallyNumber = Math.max(
    0,
    nonNegativeInt(snapshot.community.currentRallyNumber),
    nonNegativeInt(snapshot.score.currentRallyNumber),
    receiptRally
  );
  const suppliedJourney = normalizeJourney(snapshot.community.recentRallies);

  return {
    matchId: snapshot.match.id,
    matchLabel: matchLabel(snapshot.match.matchNumber, snapshot.match.roundName),
    courtLabel: snapshot.match.courtName || `Court ${snapshot.match.courtNumber}`,
    currentSet: Math.max(1, Math.round(snapshot.score.currentSet || 1)),
    isLive: snapshot.score.status !== "Final" && snapshot.assignment.status === "ACTIVE",
    isFinal: snapshot.score.status === "Final",
    teams: {
      A: {
        id: "A",
        name: displayTeamName(snapshot.match.teamAName, "Team A"),
        score: nonNegativeInt(snapshot.score.teamAScore),
        setsWon: nonNegativeInt(snapshot.score.teamASets),
        tone: "blue"
      },
      B: {
        id: "B",
        name: displayTeamName(snapshot.match.teamBName, "Team B"),
        score: nonNegativeInt(snapshot.score.teamBScore),
        setsWon: nonNegativeInt(snapshot.score.teamBSets),
        tone: "red"
      }
    },
    currentRallyNumber,
    rallyJourney: suppliedJourney.length ? suppliedJourney : fallbackJourney(currentRallyNumber, latestReceipt),
    coverageLabel: coverageLabel(snapshot.community.witnessCount, snapshot.community.confirmedTogether),
    latestReceipt,
    personalSummary: {
      contributionsRecorded: nonNegativeInt(snapshot.community.personalSummary.contributionsRecorded),
      confirmedCalls: nonNegativeInt(snapshot.community.personalSummary.confirmedCalls),
      reviewTriggers: nonNegativeInt(snapshot.community.personalSummary.reviewTriggers),
      correctionsHelped: nonNegativeInt(snapshot.community.personalSummary.correctionsHelped)
    }
  };
}

export function canSubmitContribution(snapshot: CommunitySessionSnapshot, actionType: ContributionActionType): boolean {
  if (snapshot.assignment.status !== "ACTIVE") return false;
  if (snapshot.score.status === "Final" && actionType !== "REMOVE_POINT") return false;
  if (snapshot.assignment.role === "DESIGNATED_SCORER") {
    return snapshot.score.authorityMode === "DESIGNATED_PRIMARY";
  }
  if (snapshot.community.hasContributedToCurrentRevision) return false;
  return snapshot.assignment.role === "OBSERVER" || snapshot.assignment.role === "VERIFIED_WITNESS";
}

export function canRemovePointFromScore(score: CommunityScore, team: TeamSide): boolean {
  const currentScore = team === "A" ? score.teamAScore : score.teamBScore;
  if (currentScore > 0) return true;

  // The reducer can only reach back into the latest completed set when there
  // is no partially-played current set (or the match is already final). Keep
  // the control contract aligned so an enabled Remove point never guarantees
  // a deterministic server rejection.
  const isFinal = score.status.trim().toLowerCase() === "final";
  if (!isFinal && (score.teamAScore !== 0 || score.teamBScore !== 0)) return false;

  const latestCompletedSet = [...score.setScores]
    .filter((set) => set.isComplete)
    .sort((a, b) => b.setNumber - a.setNumber)[0];
  if (!latestCompletedSet) return false;
  return team === "A" ? latestCompletedSet.teamAScore > 0 : latestCompletedSet.teamBScore > 0;
}

export function contributionRallyNumber(currentRallyNumber: number, actionType: ContributionActionType): number {
  const current = Number.isFinite(currentRallyNumber) ? Math.max(0, Math.round(currentRallyNumber)) : 0;
  return actionType === "ADD_POINT" ? current + 1 : Math.max(1, current);
}

export function freshestCommunitySnapshot(
  current: CommunitySessionSnapshot | null,
  incoming: CommunitySessionSnapshot
): CommunitySessionSnapshot {
  if (!current || current.match.id !== incoming.match.id) return incoming;
  if (incoming.score.authorityEpoch !== current.score.authorityEpoch) {
    return incoming.score.authorityEpoch > current.score.authorityEpoch ? incoming : current;
  }
  if (incoming.score.revision !== current.score.revision) {
    return incoming.score.revision > current.score.revision ? incoming : current;
  }

  const currentContributions = current.community.personalSummary.contributionsRecorded;
  const incomingContributions = incoming.community.personalSummary.contributionsRecorded;
  if (incomingContributions !== currentContributions) {
    return incomingContributions > currentContributions ? incoming : current;
  }

  const currentReceipt = current.receipt ?? current.community.latestReceipt;
  const incomingReceipt = incoming.receipt ?? incoming.community.latestReceipt;
  if (currentReceipt && !incomingReceipt) return current;
  if (!currentReceipt && incomingReceipt) return incoming;
  if (currentReceipt && incomingReceipt && currentReceipt.id === incomingReceipt.id) {
    const currentResolvedAt = receiptResolutionTimestamp(currentReceipt.resolvedAt);
    const incomingResolvedAt = receiptResolutionTimestamp(incomingReceipt.resolvedAt);
    if (currentResolvedAt !== incomingResolvedAt) {
      if (currentResolvedAt == null) return incoming;
      if (incomingResolvedAt == null) return current;
      return incomingResolvedAt > currentResolvedAt ? incoming : current;
    }

    const rankDifference = receiptResolutionRank(incomingReceipt.status) - receiptResolutionRank(currentReceipt.status);
    if (rankDifference !== 0) return rankDifference > 0 ? incoming : current;
  }

  const currentLease = Date.parse(current.assignment.leaseExpiresAt);
  const incomingLease = Date.parse(incoming.assignment.leaseExpiresAt);
  if (Number.isFinite(currentLease) && Number.isFinite(incomingLease) && incomingLease !== currentLease) {
    return incomingLease > currentLease ? incoming : current;
  }
  return Date.parse(incoming.score.updatedAt) >= Date.parse(current.score.updatedAt) ? incoming : current;
}

function receiptResolutionTimestamp(resolvedAt: string | null): number | null {
  if (!resolvedAt) return null;
  const timestamp = Date.parse(resolvedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function receiptResolutionRank(status: ContributionReceiptDto["status"]): number {
  switch (status) {
    case "RECORDED": return 1;
    case "LATE":
    case "DIFFERED": return 2;
    case "TRIGGERED_REVIEW": return 3;
    case "CONFIRMED":
    case "CONTRIBUTED_TO_CORRECTION": return 4;
  }
}

export function matchSideOrderStorageKey(matchId: string): string {
  return `scorecheck:community-side-order:${matchId}`;
}

export function contributionOutboxStorageKey(assignmentId: string): string {
  return `scorecheck:community-outbox:${assignmentId}`;
}

export function parseStoredSideOrder(raw: string | null): [TeamSide, TeamSide] {
  if (!raw) return [...DEFAULT_SIDE_ORDER];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] !== parsed[1] && isTeamSide(parsed[0]) && isTeamSide(parsed[1])) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // Corrupt local preferences are intentionally ignored.
  }
  return [...DEFAULT_SIDE_ORDER];
}

export function swapSideOrder(order: readonly [TeamSide, TeamSide]): [TeamSide, TeamSide] {
  return [order[1], order[0]];
}

export function sendingReceipt(rallyNumber: number, correction: boolean): CommunityReceipt {
  return {
    rallyNumber: correction ? null : rallyNumber,
    status: "sending",
    message: correction ? "Sending your correction…" : `Sending your call for Rally ${rallyNumber}…`
  };
}

export function failedReceipt(rallyNumber: number, correction: boolean, offline: boolean): CommunityReceipt {
  return {
    rallyNumber: correction ? null : rallyNumber,
    status: offline ? "offline" : "failed",
    message: correction
      ? offline ? "Correction saved on this screen · reconnect to submit" : "Correction was not recorded · try again"
      : offline ? `Rally ${rallyNumber} saved on this screen · reconnect to submit` : `Rally ${rallyNumber} was not recorded · try again`
  };
}

export function retryableContributionReceipt(
  rallyNumber: number,
  correction: boolean,
  mode: CommunityRetryPlan["mode"]
): CommunityReceipt {
  const subject = correction ? "Correction" : `Rally ${rallyNumber}`;
  const message = mode === "offline"
    ? `${subject} saved on this screen · reconnect or retry when online`
    : mode === "scheduled"
      ? `${subject} saved on this screen · retrying shortly`
      : `${subject} saved on this screen · tap Retry saved contribution`;
  return {
    rallyNumber: correction ? null : rallyNumber,
    status: mode === "offline" ? "offline" : mode === "scheduled" ? "retrying" : "failed",
    message
  };
}

export function successfulContributionReceipt(
  snapshot: CommunitySessionSnapshot,
  rallyNumber: number,
  correction: boolean,
  waitingForAdvance: boolean
): CommunityReceipt {
  if (snapshot.projectionStatus === "RETRYING") {
    return {
      rallyNumber: correction ? null : rallyNumber,
      status: "recorded",
      message: correction
        ? "Correction saved · broadcast catching up"
        : `Rally ${rallyNumber} saved · broadcast catching up`
    };
  }
  if (waitingForAdvance) {
    return {
      rallyNumber: correction ? null : rallyNumber,
      status: "recorded",
      message: correction
        ? "Your correction was recorded · awaiting resolution"
        : "Call recorded · waiting for the score to advance"
    };
  }
  return receiptFromSnapshot(snapshot, rallyNumber, correction, true);
}

export function reconciledReceiptFromSnapshot(
  current: CommunityReceipt | null,
  hasPendingContribution: boolean,
  snapshot: CommunitySessionSnapshot,
  preserveActionFeedback = false
): CommunityReceipt | null {
  if (preserveActionFeedback && current?.status === "failed") return current;
  if (hasPendingContribution || current?.status === "sending" || current?.status === "retrying" || current?.status === "offline") {
    return current;
  }
  const durable = snapshot.receipt ?? snapshot.community.latestReceipt;
  if (!durable) return current;
  return receiptFromSnapshot(snapshot, durable.rallyNumber, false);
}

export function receiptFromSnapshot(
  snapshot: CommunitySessionSnapshot,
  rallyNumber: number,
  correction: boolean,
  actionResponse = false
): CommunityReceipt {
  const durable = normalizeReceipt(snapshot.receipt ?? (actionResponse ? null : snapshot.community.latestReceipt));
  if (durable) return durable;

  const canonicalCommand = snapshot.assignment.role === "DESIGNATED_SCORER" && snapshot.score.authorityMode === "DESIGNATED_PRIMARY";
  return {
    rallyNumber: correction ? null : rallyNumber,
    status: canonicalCommand ? "confirmed" : "recorded",
    message: correction
      ? canonicalCommand ? "Correction recorded · broadcast updated" : "Your correction was recorded · awaiting resolution"
      : canonicalCommand ? `Rally ${rallyNumber} recorded · broadcast updated` : `Rally ${rallyNumber} recorded · awaiting resolution`
  };
}

export function journeyWithReceipt(journey: CommunityRally[], receipt: CommunityReceipt | null): CommunityRally[] {
  if (!receipt?.rallyNumber) return journey;
  const existingStatus = journey.find((rally) => rally.rallyNumber === receipt.rallyNumber)?.status;
  const receiptStatus: CommunityRally["status"] = receipt.status === "corrected"
    ? "corrected"
    : receipt.status === "confirmed"
      ? "confirmed"
      : receipt.status === "review"
        ? "review"
        : receipt.status === "differed" || receipt.status === "late"
          ? existingStatus ?? "broadcast"
          : "pending";
  const withoutCurrent = journey.filter((rally) => rally.rallyNumber !== receipt.rallyNumber);
  return [...withoutCurrent, { rallyNumber: receipt.rallyNumber, status: receiptStatus }]
    .sort((a, b) => a.rallyNumber - b.rallyNumber)
    .slice(-5);
}

function fallbackJourney(current: number, receipt: CommunityReceipt | null): CommunityRally[] {
  const start = Math.max(1, current - 4);
  const journey: CommunityRally[] = [];
  for (let rally = start; rally <= current; rally += 1) {
    journey.push({
      rallyNumber: rally,
      status: rally === current
        ? receipt?.status === "confirmed" || receipt?.status === "corrected" ? "confirmed" : "pending"
        : "pending"
    });
  }
  return journey;
}

function normalizeJourney(input: CommunityRallyDto[]): CommunityRally[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((rally) => Number.isFinite(rally.rallyNumber) && rally.rallyNumber > 0)
    .map((rally) => ({ rallyNumber: Math.round(rally.rallyNumber), status: rallyStatus(rally.status) }))
    .sort((a, b) => a.rallyNumber - b.rallyNumber)
    .slice(-5);
}

function normalizeReceipt(input: ContributionReceiptDto | null): CommunityReceipt | null {
  if (!input || typeof input.message !== "string" || !input.message.trim()) return null;
  return {
    actionId: null,
    rallyNumber: input.rallyNumber > 0 ? Math.round(input.rallyNumber) : null,
    status: receiptStatus(input.status),
    message: input.message.trim()
  };
}

function rallyStatus(status: CommunityRallyDto["status"]): CommunityRally["status"] {
  switch (status) {
    case "CONFIRMED": return "confirmed";
    case "DISPUTED": return "review";
    case "CORRECTED": return "corrected";
    case "VOIDED": return "voided";
    case "UNOBSERVED": return "pending";
  }
}

function receiptStatus(status: ContributionReceiptDto["status"]): CommunityReceiptStatus {
  switch (status) {
    case "RECORDED": return "recorded";
    case "CONFIRMED": return "confirmed";
    case "TRIGGERED_REVIEW": return "review";
    case "CONTRIBUTED_TO_CORRECTION": return "corrected";
    case "DIFFERED": return "differed";
    case "LATE": return "late";
  }
}

function coverageLabel(witnessCountInput: number, confirmedTogetherInput: number): string {
  const witnessCount = nonNegativeInt(witnessCountInput);
  const confirmedTogether = nonNegativeInt(confirmedTogetherInput);
  if (witnessCount > 0 && confirmedTogether > 0) {
    return `${witnessCount} ${witnessCount === 1 ? "witness" : "witnesses"} · ${confirmedTogether} ${confirmedTogether === 1 ? "rally" : "rallies"} confirmed together`;
  }
  if (witnessCount > 0) {
    return `${witnessCount} ${witnessCount === 1 ? "witness" : "witnesses"} · community coverage is active`;
  }
  return "You’re contributing · community coverage is building";
}

function matchLabel(matchNumber: string | null, roundName: string | null): string {
  const normalizedNumber = matchNumber?.trim();
  if (normalizedNumber) return /^match\b/i.test(normalizedNumber) ? normalizedNumber : `Match ${normalizedNumber}`;
  return roundName?.trim() || "Live match";
}

function displayTeamName(value: string, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized || /^team on (left|right)$/i.test(normalized)) return fallback;
  return normalized;
}

function nonNegativeInt(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function isTeamSide(value: unknown): value is TeamSide {
  return value === "A" || value === "B";
}
