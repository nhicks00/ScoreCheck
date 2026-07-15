import { z } from "zod";
import { AUTHORITATIVE_FRAME_MAX_AGE_MS } from "./communityPlaybackTiming";

const BROKERED_SCORING_SESSION_ID_PATTERN = /^whep-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const authorityModeSchema = z.enum([
  "ADMIN_LOCKED",
  "PROVIDER_PRIMARY",
  "DESIGNATED_PRIMARY",
  "VERIFIED_CONSENSUS",
  "PAUSED_DISPUTE"
]);

export const teamSideSchema = z.enum(["A", "B"]);
export const clientActionIdSchema = z.string().uuid();

const playbackBlockReasonSchema = z.enum([
  "transport_not_whep",
  "session_missing",
  "broker_session_missing",
  "connection_not_connected",
  "reconnecting",
  "playback_paused",
  "playback_stalled",
  "media_not_ready",
  "rendered_frame_missing",
  "rendered_frame_session_mismatch",
  "rendered_frame_stale"
]);

export const playbackEvidenceSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(8).max(100).regex(/^(whep|hls)-[A-Za-z0-9-]+$/).nullable(),
  transport: z.enum(["whep", "hls", "none"]),
  connectionState: z.enum(["new", "connecting", "connected", "disconnected", "failed", "closed", "unknown"]),
  sampledAtMs: z.number().finite().min(0),
  baseRevision: z.number().int().min(0).nullable(),
  currentTimeSeconds: z.number().finite().min(0).nullable(),
  readyState: z.number().int().min(0).max(4),
  videoWidth: z.number().int().min(0).max(16_384),
  videoHeight: z.number().int().min(0).max(16_384),
  paused: z.boolean(),
  stalled: z.boolean(),
  reconnecting: z.boolean(),
  frame: z.object({
    source: z.literal("video-frame-callback"),
    sessionId: z.string().min(8).max(100).regex(/^(whep|hls)-[A-Za-z0-9-]+$/),
    presentedFrames: z.number().int().min(0),
    mediaTimeSeconds: z.number().finite().min(0),
    observedAtMs: z.number().finite().min(0)
  }).strict().nullable(),
  qualification: z.object({
    liveActionEligible: z.boolean(),
    blockedReason: playbackBlockReasonSchema.nullable(),
    frameAgeMs: z.number().finite().min(0).nullable(),
    maxFrameAgeMs: z.number().int().positive().max(10_000)
  }).strict(),
  correlation: z.literal("uncorrelated_client_diagnostic")
}).strict();

export const setScoreSchema = z.object({
  setNumber: z.number().int().min(1).max(99),
  teamAScore: z.number().int().min(0).max(999),
  teamBScore: z.number().int().min(0).max(999),
  isComplete: z.boolean()
}).strict();

export const canonicalScoreInputSchema = z.object({
  teamAScore: z.number().int().min(0).max(999),
  teamBScore: z.number().int().min(0).max(999),
  teamASets: z.number().int().min(0).max(99),
  teamBSets: z.number().int().min(0).max(99),
  currentSet: z.number().int().min(1).max(99),
  setScores: z.array(setScoreSchema).max(99),
  servingTeam: teamSideSchema.nullable(),
  timeouts: z.record(z.unknown()),
  status: z.enum(["Pre-Match", "In Progress", "Set Complete", "Final"]),
  currentRallyNumber: z.number().int().min(0)
}).strict();

export const scoreCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ADD_POINT"), team: teamSideSchema }).strict(),
  z.object({ type: z.literal("REMOVE_POINT"), team: teamSideSchema }).strict(),
  z.object({ type: z.literal("SET_CURRENT_SET"), set: z.number().int().min(1).max(99) }).strict(),
  z.object({ type: z.literal("CORRECT_SCORE"), score: canonicalScoreInputSchema }).strict(),
  z.object({ type: z.literal("COMPLETE_SET") }).strict(),
  z.object({ type: z.literal("COMPLETE_MATCH") }).strict(),
  z.object({ type: z.literal("SET_SERVE"), team: teamSideSchema }).strict()
]);

export const observationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ADD_POINT"), team: teamSideSchema }).strict(),
  z.object({ type: z.literal("REMOVE_POINT"), team: teamSideSchema }).strict()
]);

export const joinCommunitySchema = z.object({
  eventSlug: z.string().trim().min(1).max(120),
  courtNumber: z.number().int().min(1).max(64),
  displayName: z.string().trim().min(1).max(80),
  participationMode: z.enum(["REMOTE", "COURTSIDE"]).default("REMOTE"),
  requestedRole: z.enum(["OBSERVER", "DESIGNATED_SCORER"]).default("OBSERVER"),
  joinCode: z.string().min(16).max(256).optional()
}).strict();

export const submitObservationSchema = z.object({
  clientActionId: clientActionIdSchema,
  baseRevision: z.number().int().min(0),
  observation: observationSchema,
  playbackTimestampMs: z.number().int().min(0).optional(),
  deviceSequence: z.number().int().min(0).optional()
}).strict();

export const submitCommandSchema = z.object({
  clientActionId: clientActionIdSchema,
  expectedRevision: z.number().int().min(0),
  action: scoreCommandSchema,
  playbackEvidence: playbackEvidenceSchema.optional()
}).strict().superRefine((input, context) => {
  const pointAction = input.action.type === "ADD_POINT" || input.action.type === "REMOVE_POINT";
  const remoteMediaAction = pointAction || input.action.type === "SET_CURRENT_SET";
  if (!remoteMediaAction) {
    if (input.playbackEvidence != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["playbackEvidence"],
        message: "Playback evidence is valid only for live-authoritative actions"
      });
    }
    return;
  }

  const evidence = input.playbackEvidence;
  // Whether evidence is mandatory depends on the server-held trust tier:
  // remote designated scorers require it, while organizer-verified courtside
  // scorers may use direct sight of the physical court. The atomic RPC makes
  // that authorization decision; supplied evidence must still be coherent.
  if (evidence == null) return;
  const frame = evidence?.frame;
  const frameAge = evidence && frame ? Math.max(0, evidence.sampledAtMs - frame.observedAtMs) : null;
  const qualified = evidence != null
    && evidence.baseRevision === input.expectedRevision
    && evidence.transport === "whep"
    && evidence.connectionState === "connected"
    && evidence.sessionId != null
    && BROKERED_SCORING_SESSION_ID_PATTERN.test(evidence.sessionId)
    && evidence.paused === false
    && evidence.stalled === false
    && evidence.reconnecting === false
    && evidence.readyState >= 2
    && evidence.videoWidth > 0
    && evidence.videoHeight > 0
    && frame != null
    && frame.sessionId === evidence.sessionId
    && frameAge != null
    && frameAge <= AUTHORITATIVE_FRAME_MAX_AGE_MS
    && evidence.qualification.liveActionEligible === true
    && evidence.qualification.blockedReason == null
    && evidence.qualification.frameAgeMs === frameAge
    && evidence.qualification.maxFrameAgeMs === AUTHORITATIVE_FRAME_MAX_AGE_MS;
  if (!qualified) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["playbackEvidence"],
      message: "A fresh brokered WHEP frame is required for live-authoritative actions"
    });
  }
});

export const commandStatusSchema = z.object({
  clientActionId: clientActionIdSchema
}).strict();

export const releaseCommunitySchema = z.object({
  clientActionId: clientActionIdSchema
}).strict();

export const receiptSchema = z.object({
  id: z.string().uuid(),
  rallyNumber: z.number().int().min(0),
  status: z.enum([
    "RECORDED",
    "CONFIRMED",
    "TRIGGERED_REVIEW",
    "CONTRIBUTED_TO_CORRECTION",
    "DIFFERED",
    "LATE"
  ]),
  message: z.string(),
  canonicalRevision: z.number().int().min(0).nullable(),
  resolvedAt: z.string().nullable()
}).strict();

export const assignmentSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  courtId: z.string().uuid(),
  matchId: z.string().uuid(),
  displayName: z.string(),
  role: z.enum(["OBSERVER", "VERIFIED_WITNESS", "DESIGNATED_SCORER"]),
  trustTier: z.enum(["REMOTE", "COURTSIDE", "VERIFIED_COURTSIDE"]),
  status: z.enum(["ACTIVE", "RELEASED", "REVOKED", "EXPIRED", "MATCH_ENDED"]),
  authorityEpoch: z.number().int().positive(),
  leaseExpiresAt: z.string()
}).strict();

export const matchSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  courtId: z.string().uuid(),
  courtNumber: z.number().int().positive(),
  courtName: z.string(),
  teamAName: z.string(),
  teamBName: z.string(),
  matchNumber: z.string().nullable(),
  roundName: z.string().nullable(),
  format: z.record(z.unknown())
}).strict();

export const canonicalScoreSchema = canonicalScoreInputSchema.extend({
  revision: z.number().int().min(0),
  authorityEpoch: z.number().int().positive(),
  authorityMode: authorityModeSchema,
  stateHash: z.string().length(64),
  updatedAt: z.string()
}).strict();

export const personalSummarySchema = z.object({
  contributionsRecorded: z.number().int().min(0),
  confirmedCalls: z.number().int().min(0),
  reviewTriggers: z.number().int().min(0),
  correctionsHelped: z.number().int().min(0)
}).strict();

export const communityEngagementSchema = z.object({
  currentRallyNumber: z.number().int().min(0),
  witnessCount: z.number().int().min(0),
  confirmedTogether: z.number().int().min(0),
  hasContributedToCurrentRevision: z.boolean(),
  recentRallies: z.array(z.object({
    rallyNumber: z.number().int().min(0),
    status: z.enum(["UNOBSERVED", "CONFIRMED", "DISPUTED", "CORRECTED", "VOIDED"])
  }).strict()),
  latestReceipt: receiptSchema.nullable(),
  personalSummary: personalSummarySchema
}).strict();

export const communitySessionResponseSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
  noOp: z.boolean().optional(),
  eventId: z.string().uuid().nullable().optional(),
  outboxId: z.string().uuid().nullable().optional(),
  assignment: assignmentSchema,
  match: matchSchema,
  score: canonicalScoreSchema,
  receipt: receiptSchema.nullable(),
  community: communityEngagementSchema
}).strict();

export const trustedCommitResponseSchema = z.object({
  ok: z.literal(true),
  duplicate: z.boolean(),
  noOp: z.boolean().optional(),
  eventId: z.string().uuid().nullable(),
  outboxId: z.string().uuid().nullable(),
  match: matchSchema,
  score: canonicalScoreSchema,
  community: communityEngagementSchema
}).strict();

export type AuthorityMode = z.infer<typeof authorityModeSchema>;
export type CanonicalScoreInput = z.infer<typeof canonicalScoreInputSchema>;
export type ScoreCommand = z.infer<typeof scoreCommandSchema>;
export type CommunityObservation = z.infer<typeof observationSchema>;
export type CommunitySessionResponse = z.infer<typeof communitySessionResponseSchema>;
export type TrustedCommitResponse = z.infer<typeof trustedCommitResponseSchema>;
