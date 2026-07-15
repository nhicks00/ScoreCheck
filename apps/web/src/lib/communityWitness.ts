import { z } from "zod";
import { generateSessionToken, hashToken, safeDisplayName } from "./security";
import { supabaseAdmin } from "./supabase";
import {
  authorityModeSchema,
  canonicalScoreInputSchema,
  communitySessionResponseSchema,
  joinCommunitySchema,
  observationSchema,
  playbackEvidenceSchema,
  scoreCommandSchema,
  trustedCommitResponseSchema,
  type AuthorityMode,
  type CommunityObservation,
  type CommunitySessionResponse,
  type ScoreCommand,
  type TrustedCommitResponse
} from "./communityWitnessSchemas";

export const communitySessionCookie = "mcs_community_session";
export const communitySessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 12 * 60 * 60
};

export class CommunityWitnessError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

const projectionMetadataSchema = z.object({
  source: z.enum(["api", "manual", "override"]),
  sourceAvailable: z.boolean(),
  sourcePriority: z.enum(["primary", "fallback", "override"]),
  sourcePendingScores: z.array(z.unknown()),
  stale: z.boolean(),
  message: z.string().max(1_000).nullable(),
  lastApiPollAt: z.string().datetime().nullable(),
  lastScoreChangeAt: z.string().datetime().nullable()
}).strict();

const canonicalCommandTypeSchema = z.enum([
  "ADD_POINT", "REMOVE_POINT", "CORRECT_SCORE",
  "COMPLETE_SET", "COMPLETE_MATCH", "SET_SERVE", "SET_CURRENT_SET"
]);
const secretHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

async function rpc<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await supabaseAdmin().rpc(name, args);
  if (error) throw communityError(error.message, error.code);
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new CommunityWitnessError(`Invalid ${name} response: ${parsed.error.message}`, 500, "INVALID_RPC_RESPONSE");
  }
  return parsed.data;
}

function communityError(message: string, code?: string): CommunityWitnessError {
  const status = communityErrorStatus(code);
  return new CommunityWitnessError(message, status, code);
}

export function communityErrorStatus(code?: string): number {
  return code === "P0002" ? 404
    : code === "P0003" ? 410
      : code === "P0004" ? 429
      : code === "P0005" ? 409
      : code === "28000" ? 403
      : ["23505", "40001", "40P01", "55000"].includes(code ?? "") ? 409
        : ["22023", "23514"].includes(code ?? "") ? 400
          : 500;
}

const admissionQuotaSchema = z.object({
  allowed: z.boolean(),
  reason: z.enum(["DEVICE_RATE_LIMIT", "NETWORK_RATE_LIMIT"]).nullable(),
  deviceAttempts: z.number().int().min(0).nullable(),
  ipAttempts: z.number().int().min(0)
}).strict();

export function consumeCommunityAdmissionQuota(input: { deviceTokenHash: string; ipHash: string }) {
  return rpc("community_consume_admission_quota", {
    p_device_token_hash: secretHashSchema.parse(input.deviceTokenHash),
    p_ip_hash: secretHashSchema.parse(input.ipHash)
  }, admissionQuotaSchema);
}

export async function joinCommunity(
  input: z.input<typeof joinCommunitySchema>,
  identity: { deviceTokenHash: string }
) {
  const parsed = joinCommunitySchema.parse(input);
  const sessionToken = generateSessionToken();
  const response = await rpc("community_join_assignment", {
    p_event_slug: parsed.eventSlug,
    p_court_number: parsed.courtNumber,
    p_display_name: safeDisplayName(parsed.displayName),
    p_session_token_hash: hashToken(sessionToken),
    p_device_token_hash: secretHashSchema.parse(identity.deviceTokenHash),
    p_requested_role: parsed.requestedRole,
    p_participation_mode: parsed.participationMode,
    p_grant_token_hash: parsed.joinCode ? hashToken(parsed.joinCode) : null,
    p_lease_seconds: 120
  }, communitySessionResponseSchema);
  return { sessionToken, response };
}

export function getCommunitySession(sessionToken: string) {
  return rpc("community_session_snapshot", {
    p_session_token_hash: hashToken(sessionToken)
  }, communitySessionResponseSchema);
}

const eventCommunityStatusSchema = z.array(z.object({
  courtId: z.string().uuid(),
  matchId: z.string().uuid().nullable(),
  activeDesignatedName: z.string().nullable(),
  activeAssignmentCount: z.number().int().min(0),
  activeWitnessCount: z.number().int().min(0),
  needsScorer: z.boolean()
}).strict());

export function getCommunityStatusForEvent(eventId: string) {
  return rpc("community_status_for_event", {
    p_event_id: z.string().uuid().parse(eventId)
  }, eventCommunityStatusSchema);
}

export function heartbeatCommunitySession(sessionToken: string) {
  return rpc("community_heartbeat_assignment", {
    p_session_token_hash: hashToken(sessionToken),
    p_lease_seconds: 120
  }, communitySessionResponseSchema);
}

export function submitCommunityObservation(input: {
  sessionToken: string;
  clientActionId: string;
  baseRevision: number;
  observation: CommunityObservation;
  playbackTimestampMs?: number;
  deviceSequence?: number;
}) {
  const observation = observationSchema.parse(input.observation);
  return rpc("community_submit_observation", {
    p_session_token_hash: hashToken(input.sessionToken),
    p_client_action_id: z.string().uuid().parse(input.clientActionId),
    p_base_revision: z.number().int().min(0).parse(input.baseRevision),
    p_action_type: observation.type,
    p_team_side: observation.team,
    p_playback_timestamp_ms: input.playbackTimestampMs ?? null,
    p_device_sequence: input.deviceSequence ?? null
  }, communitySessionResponseSchema);
}

export function submitCommunityCommand(input: {
  sessionToken: string;
  clientActionId: string;
  expectedRevision: number;
  action: ScoreCommand;
  playbackEvidence?: unknown;
}) {
  return rpc("community_submit_scorer_command_with_evidence", {
    p_session_token_hash: hashToken(input.sessionToken),
    p_client_action_id: z.string().uuid().parse(input.clientActionId),
    p_expected_revision: z.number().int().min(0).parse(input.expectedRevision),
    p_action: scoreCommandSchema.parse(input.action),
    p_playback_evidence: input.playbackEvidence == null
      ? null
      : playbackEvidenceSchema.parse(input.playbackEvidence)
  }, communitySessionResponseSchema);
}

export function isCommunityCommandRecorded(input: {
  sessionToken: string;
  clientActionId: string;
}) {
  return rpc("community_scorer_command_recorded", {
    p_session_token_hash: hashToken(input.sessionToken),
    p_client_action_id: z.string().uuid().parse(input.clientActionId)
  }, z.boolean());
}

export function releaseCommunitySession(input: { sessionToken: string; clientActionId: string }) {
  return rpc("community_release_assignment", {
    p_session_token_hash: hashToken(input.sessionToken),
    p_action_id: z.string().uuid().parse(input.clientActionId)
  }, communitySessionResponseSchema);
}

export async function createTrustedCommunityAssignment(input: {
  eventId: string;
  courtId: string;
  matchId: string;
  displayName: string;
  role: "OBSERVER" | "VERIFIED_WITNESS" | "DESIGNATED_SCORER";
  trustTier?: "REMOTE" | "COURTSIDE" | "VERIFIED_COURTSIDE";
  leaseSeconds?: number;
  actionId?: string;
  actorLabel?: string;
}) {
  const sessionToken = generateSessionToken();
  const response = await rpc("community_create_trusted_assignment", {
    p_event_id: z.string().uuid().parse(input.eventId),
    p_court_id: z.string().uuid().parse(input.courtId),
    p_match_id: z.string().uuid().parse(input.matchId),
    p_display_name: safeDisplayName(input.displayName),
    p_session_token_hash: hashToken(sessionToken),
    p_role: input.role,
    p_trust_tier: input.trustTier ?? "VERIFIED_COURTSIDE",
    p_lease_seconds: input.leaseSeconds ?? 120,
    p_action_id: input.actionId ?? crypto.randomUUID(),
    p_actor_label: input.actorLabel ?? "Trusted assignment"
  }, communitySessionResponseSchema);
  return { sessionToken, response };
}

export async function claimTrustedCommunityDesignatedAssignment(input: {
  eventId: string;
  courtId: string;
  matchId: string;
  sessionToken: string;
  displayName: string;
  leaseSeconds?: number;
  actionId: string;
  actorLabel?: string;
}) {
  const response = await rpc("community_claim_trusted_designated_assignment", {
    p_event_id: z.string().uuid().parse(input.eventId),
    p_court_id: z.string().uuid().parse(input.courtId),
    p_match_id: z.string().uuid().parse(input.matchId),
    p_session_token_hash: hashToken(input.sessionToken),
    p_display_name: safeDisplayName(input.displayName),
    p_lease_seconds: input.leaseSeconds ?? 120,
    p_action_id: z.string().uuid().parse(input.actionId),
    p_actor_label: input.actorLabel ?? "Trusted designated assignment claim"
  }, communitySessionResponseSchema);
  return { sessionToken: input.sessionToken, response };
}

export async function commitTrustedCanonicalScore(input: {
  eventId: string;
  courtId: string;
  matchId: string;
  actionId: string;
  actorType: "ADMIN" | "PROVIDER" | "SYSTEM";
  actorLabel?: string;
  authorityMode: AuthorityMode;
  expectedRevision?: number;
  expectedAuthorityEpoch?: number;
  state: unknown;
  commandType?: "ADD_POINT" | "REMOVE_POINT" | "CORRECT_SCORE" | "COMPLETE_SET" | "COMPLETE_MATCH" | "SET_SERVE" | "SET_CURRENT_SET";
  teamSide?: "A" | "B" | null;
  projectionMetadata: z.infer<typeof projectionMetadataSchema>;
  metadata?: Record<string, unknown>;
}): Promise<TrustedCommitResponse> {
  const commandType = canonicalCommandTypeSchema.parse(input.commandType ?? "CORRECT_SCORE");
  const teamSide = input.teamSide == null ? null : z.enum(["A", "B"]).parse(input.teamSide);
  return rpc("community_commit_trusted_score", {
    p_event_id: z.string().uuid().parse(input.eventId),
    p_court_id: z.string().uuid().parse(input.courtId),
    p_match_id: z.string().uuid().parse(input.matchId),
    p_action_id: z.string().uuid().parse(input.actionId),
    p_actor_type: input.actorType,
    p_actor_label: input.actorLabel ?? null,
    p_authority_mode: authorityModeSchema.parse(input.authorityMode),
    p_expected_revision: input.expectedRevision ?? null,
    p_expected_authority_epoch: input.expectedAuthorityEpoch ?? null,
    p_state: canonicalScoreInputSchema.parse(input.state),
    p_command_type: commandType,
    p_team_side: teamSide,
    p_projection_metadata: projectionMetadataSchema.parse(input.projectionMetadata),
    p_metadata: input.metadata ?? {}
  }, trustedCommitResponseSchema);
}

const outboxResultSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
  outboxId: z.string().uuid(),
  revision: z.number().int().positive(),
  status: z.enum(["PUBLISHED", "FAILED"]),
  attemptCount: z.number().int().min(0).optional(),
  nextAttemptAt: z.string().optional()
}).strict();

export function markCanonicalOutboxResult(input: {
  outboxId: string;
  revision: number;
  outcome: "PUBLISHED" | "FAILED";
  error?: string;
}) {
  return rpc("community_mark_score_outbox", {
    p_outbox_id: z.string().uuid().parse(input.outboxId),
    p_revision: z.number().int().positive().parse(input.revision),
    p_outcome: input.outcome,
    p_error: input.error ?? null
  }, outboxResultSchema);
}

const outboxProjectionResultSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
  outboxId: z.string().uuid(),
  revision: z.number().int().positive(),
  status: z.enum(["PUBLISHED", "HISTORICAL", "RETRY"]),
  currentRevision: z.number().int().positive().optional()
}).strict();

/**
 * Atomically validates the court/match/revision scope, writes the overlay,
 * and publishes the outbox row. The database holds the court lock across all
 * three operations so a match transition cannot interleave a stale overlay.
 */
export function publishCanonicalOutboxProjection(input: {
  outboxId: string;
  projectionRevision: number;
  overlayPayload: Record<string, unknown>;
  courtStatus: string;
  stale: boolean;
}) {
  return rpc("community_publish_score_outbox", {
    p_outbox_id: z.string().uuid().parse(input.outboxId),
    p_projection_revision: z.number().int().positive().parse(input.projectionRevision),
    p_overlay_payload: z.record(z.unknown()).parse(input.overlayPayload),
    p_court_status: z.string().trim().min(1).max(80).parse(input.courtStatus),
    p_stale: z.boolean().parse(input.stale)
  }, outboxProjectionResultSchema);
}

const claimedOutboxSchema = z.array(z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  courtId: z.string().uuid(),
  matchId: z.string().uuid(),
  revision: z.number().int().positive(),
  scorePayload: z.record(z.unknown()),
  attemptCount: z.number().int().min(0),
  claimExpiresAt: z.string()
}).strict());

export function claimCanonicalScoreOutbox(input: { workerId: string; limit?: number; leaseSeconds?: number }) {
  return rpc("community_claim_score_outbox", {
    p_worker_id: z.string().trim().min(1).max(120).parse(input.workerId),
    p_limit: z.number().int().min(1).max(100).parse(input.limit ?? 20),
    p_lease_seconds: z.number().int().min(5).max(300).parse(input.leaseSeconds ?? 30)
  }, claimedOutboxSchema);
}

export function promoteCommunityAssignment(input: {
  assignmentId: string; expectedAuthorityEpoch: number; actionId: string; actorLabel?: string;
}) {
  return rpc("community_promote_assignment", {
    p_assignment_id: z.string().uuid().parse(input.assignmentId),
    p_expected_authority_epoch: z.number().int().positive().parse(input.expectedAuthorityEpoch),
    p_action_id: z.string().uuid().parse(input.actionId),
    p_actor_label: input.actorLabel ?? "Admin"
  }, communitySessionResponseSchema);
}

export function verifyCommunityAssignment(input: { assignmentId: string; actionId: string; actorLabel?: string }) {
  return rpc("community_verify_assignment", {
    p_assignment_id: z.string().uuid().parse(input.assignmentId),
    p_action_id: z.string().uuid().parse(input.actionId),
    p_actor_label: input.actorLabel ?? "Admin"
  }, communitySessionResponseSchema);
}

export function endCommunityAssignment(input: {
  assignmentId: string; action: "RELEASE" | "REVOKE"; actionId: string; actorLabel?: string;
}) {
  return rpc("community_admin_end_assignment", {
    p_assignment_id: z.string().uuid().parse(input.assignmentId),
    p_action: input.action,
    p_action_id: z.string().uuid().parse(input.actionId),
    p_actor_label: input.actorLabel ?? "Admin"
  }, communitySessionResponseSchema);
}

const authorityResponseSchema = z.object({
  ok: z.literal(true), duplicate: z.boolean(), selectedAuthorityMode: authorityModeSchema.optional(),
  match: z.record(z.unknown()), score: z.record(z.unknown()), community: z.record(z.unknown())
}).strict();

export function changeCommunityAuthority(input: {
  matchId: string; authorityMode: AuthorityMode; expectedAuthorityEpoch: number;
  actorType: "ADMIN" | "PROVIDER" | "SYSTEM"; actorLabel: string; actionId?: string;
}) {
  return rpc("community_change_authority", {
    p_match_id: z.string().uuid().parse(input.matchId),
    p_authority_mode: authorityModeSchema.parse(input.authorityMode),
    p_expected_authority_epoch: z.number().int().positive().parse(input.expectedAuthorityEpoch),
    p_action_id: input.actionId ?? crypto.randomUUID(),
    p_actor_type: input.actorType,
    p_actor_label: input.actorLabel
  }, authorityResponseSchema);
}

export function resolveCommunityFallbackAuthority(input: {
  matchId: string; expectedAuthorityEpoch: number; actionId?: string; actorLabel?: string;
}) {
  return rpc("community_resolve_fallback_authority", {
    p_match_id: z.string().uuid().parse(input.matchId),
    p_expected_authority_epoch: z.number().int().positive().parse(input.expectedAuthorityEpoch),
    p_action_id: input.actionId ?? crypto.randomUUID(),
    p_actor_label: input.actorLabel ?? "Score source fallback"
  }, authorityResponseSchema);
}

const transitionResponseSchema = z.object({
  ok: z.literal(true), duplicate: z.boolean(), eventId: z.string().uuid().nullable().optional(),
  oldMatchId: z.string().uuid().nullable(), newMatchId: z.string().uuid().nullable(),
  match: z.record(z.unknown()).nullable().optional(), score: z.record(z.unknown()).nullable(),
  community: z.record(z.unknown()).nullable()
}).strict();

export function transitionCommunityMatch(input: {
  eventId: string; courtId: string; fromMatchId: string | null; toMatchId: string | null;
  actionId: string; actorType: "ADMIN" | "PROVIDER" | "SYSTEM"; actorLabel: string;
  initialAuthorityMode?: AuthorityMode;
}) {
  return rpc("community_transition_match", {
    p_event_id: z.string().uuid().parse(input.eventId),
    p_court_id: z.string().uuid().parse(input.courtId),
    p_from_match_id: input.fromMatchId,
    p_to_match_id: input.toMatchId,
    p_action_id: z.string().uuid().parse(input.actionId),
    p_actor_type: input.actorType,
    p_actor_label: input.actorLabel,
    p_initial_authority_mode: authorityModeSchema.parse(input.initialAuthorityMode ?? "PAUSED_DISPUTE")
  }, transitionResponseSchema);
}

const grantResponseSchema = z.object({
  duplicate: z.boolean(),
  id: z.string().uuid(), eventId: z.string().uuid(), courtId: z.string().uuid(), matchId: z.string().uuid(),
  role: z.enum(["OBSERVER", "VERIFIED_WITNESS", "DESIGNATED_SCORER"]), label: z.string().nullable(),
  maxUses: z.number().int().positive(), expiresAt: z.string()
}).strict();

const randomActionIdSchema = z.string().uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
);

export async function createCommunityJoinGrant(input: {
  eventId: string; courtId: string; matchId: string;
  role: "OBSERVER" | "VERIFIED_WITNESS" | "DESIGNATED_SCORER";
  label?: string; maxUses?: number; expiresAt: string; createdBy: string; actionId: string;
}) {
  // UUID v4 supplies 122 random bits. Reusing the stable client action ID as
  // the one-use secret makes a lost-response retry recover the same invite.
  const joinCode = randomActionIdSchema.parse(input.actionId).toLowerCase();
  const grant = await rpc("community_create_join_grant", {
    p_event_id: z.string().uuid().parse(input.eventId),
    p_court_id: z.string().uuid().parse(input.courtId),
    p_match_id: z.string().uuid().parse(input.matchId),
    p_action_id: joinCode,
    p_token_hash: hashToken(joinCode), p_grant_role: input.role,
    p_label: input.label ?? "", p_max_uses: input.maxUses ?? 1,
    p_expires_at: z.string().datetime().parse(input.expiresAt), p_created_by: input.createdBy
  }, grantResponseSchema);
  return { joinCode, grant };
}

const courtStatusSchema = z.object({
  activeDesignatedName: z.string().nullable(), activeAssignmentCount: z.number().int().min(0),
  activeWitnessCount: z.number().int().min(0), needsScorer: z.boolean()
}).strict().nullable();

export function communityStatusForCourt(courtId: string) {
  return rpc("community_status_for_court", { p_court_id: z.string().uuid().parse(courtId) }, courtStatusSchema);
}

const adminAssignmentSummarySchema = z.object({
  assignments: z.array(z.object({
    id: z.string().uuid(),
    event_id: z.string().uuid(),
    court_id: z.string().uuid(),
    match_id: z.string().uuid(),
    role: z.enum(["OBSERVER", "VERIFIED_WITNESS", "DESIGNATED_SCORER"]),
    trust_tier: z.enum(["REMOTE", "COURTSIDE", "VERIFIED_COURTSIDE"]),
    status: z.enum(["ACTIVE", "RELEASED", "REVOKED", "EXPIRED", "MATCH_ENDED"]),
    display_name: z.string(),
    last_seen_at: z.string().nullable(),
    lease_expires_at: z.string().nullable(),
    created_at: z.string()
  }).strict()),
  courtCounts: z.array(z.object({
    courtId: z.string().uuid(),
    matchId: z.string().uuid().nullable(),
    activeAssignmentCount: z.number().int().min(0),
    activeObserverCount: z.number().int().min(0),
    activeVerifiedWitnessCount: z.number().int().min(0),
    activeDesignatedCount: z.number().int().min(0),
    returnedObserverCount: z.number().int().min(0)
  }).strict())
}).strict();

export function getCommunityAdminAssignmentSummary(input: { eventId: string; observerLimitPerCourt?: number }) {
  return rpc("community_admin_assignment_summary", {
    p_event_id: z.string().uuid().parse(input.eventId),
    p_observer_limit_per_court: z.number().int().min(1).max(100).parse(input.observerLimitPerCourt ?? 25)
  }, adminAssignmentSummarySchema);
}

const openDisputeSchema = z.object({
  id: z.string().uuid(), eventId: z.string().uuid(), courtId: z.string().uuid(), matchId: z.string().uuid(),
  rallyNumber: z.number().int().min(0), baseRevision: z.number().int().min(0),
  status: z.enum(["OPEN", "ACKNOWLEDGED"]),
  expectedActionType: z.enum(["ADD_POINT", "REMOVE_POINT"]),
  expectedTeamSide: z.enum(["A", "B"]), canonicalEventId: z.string().uuid().nullable(),
  resolutionKind: z.enum(["POST_CANONICAL_DISSENT", "UNAPPLIED_MAJORITY_PROPOSAL", "NO_CONSENSUS_REVIEW"]),
  alreadyApplied: z.boolean(), differingCount: z.number().int().min(0),
  eligibleVoteCount: z.number().int().min(0), proposalVoteCount: z.number().int().min(0),
  proposalEligible: z.boolean(),
  voteBreakdown: z.array(z.object({
    actionType: z.enum(["ADD_POINT", "REMOVE_POINT"]),
    teamSide: z.enum(["A", "B"]),
    count: z.number().int().min(0)
  }).strict()),
  openedAt: z.string(), teamAName: z.string(), teamBName: z.string()
}).strict();

export function listOpenCommunityDisputes(input: { eventId: string; courtId?: string }) {
  return rpc("community_list_open_disputes", {
    p_event_id: z.string().uuid().parse(input.eventId),
    p_court_id: input.courtId ? z.string().uuid().parse(input.courtId) : null
  }, z.object({
    disputes: z.array(openDisputeSchema),
    totalOpenCount: z.number().int().min(0),
    truncated: z.boolean(),
    limit: z.number().int().positive().max(200)
  }).strict());
}

const disputeResolutionSchema = z.object({
  ok: z.literal(true), duplicate: z.boolean(), disputeId: z.string().uuid(),
  matchId: z.string().uuid().optional(), rallyNumber: z.number().int().min(0).optional(),
  status: z.enum(["RESOLVED", "DISMISSED"]), resolution: z.string().nullable(),
  canonicalEventId: z.string().uuid().nullable().optional(),
  eventId: z.string().uuid().nullable().optional(),
  outboxId: z.string().uuid().nullable().optional(),
  match: z.record(z.unknown()).nullable().optional(),
  score: z.record(z.unknown()).nullable().optional(),
  community: z.record(z.unknown()).nullable().optional(),
  resolvedAt: z.string().nullable()
}).strict();

export function resolveCommunityDispute(input: {
  disputeId: string;
  outcome: "RESOLVED" | "DISMISSED";
  resolution: string;
  canonicalEventId?: string | null;
  expectedRevision: number;
  expectedAuthorityEpoch: number;
  actorLabel: string;
}) {
  if (input.outcome === "RESOLVED" && !input.canonicalEventId) {
    throw new CommunityWitnessError("Resolved dispute requires a canonical correction event", 400);
  }
  return rpc("community_resolve_dispute", {
    p_dispute_id: z.string().uuid().parse(input.disputeId),
    p_outcome: input.outcome,
    p_resolution: z.string().trim().min(1).max(1000).parse(input.resolution),
    p_canonical_event_id: input.canonicalEventId ?? null,
    p_expected_revision: z.number().int().min(0).parse(input.expectedRevision),
    p_expected_authority_epoch: z.number().int().positive().parse(input.expectedAuthorityEpoch),
    p_actor_label: z.string().trim().min(1).max(120).parse(input.actorLabel)
  }, disputeResolutionSchema);
}

const disputeProposalApplicationSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
  disputeId: z.string().uuid(),
  matchId: z.string().uuid().optional(),
  rallyNumber: z.number().int().min(0).optional(),
  status: z.literal("RESOLVED"),
  resolution: z.string().nullable(),
  canonicalEventId: z.string().uuid(),
  eventId: z.string().uuid(),
  outboxId: z.string().uuid(),
  match: z.record(z.unknown()),
  score: z.record(z.unknown()),
  community: z.record(z.unknown()),
  resolvedAt: z.string().nullable()
}).strict();

export function applyCommunityDisputeProposal(input: {
  disputeId: string;
  expectedRevision: number;
  expectedAuthorityEpoch: number;
  actionId: string;
  actorLabel: string;
}) {
  return rpc("community_apply_dispute_proposal", {
    p_dispute_id: z.string().uuid().parse(input.disputeId),
    p_expected_revision: z.number().int().min(0).parse(input.expectedRevision),
    p_expected_authority_epoch: z.number().int().positive().parse(input.expectedAuthorityEpoch),
    p_action_id: z.string().uuid().parse(input.actionId),
    p_actor_label: z.string().trim().min(1).max(120).parse(input.actorLabel)
  }, disputeProposalApplicationSchema);
}

export type { CommunitySessionResponse, TrustedCommitResponse };
