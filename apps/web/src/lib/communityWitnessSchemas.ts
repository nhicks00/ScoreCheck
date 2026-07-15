import { z } from "zod";

export const authorityModeSchema = z.enum([
  "ADMIN_LOCKED",
  "PROVIDER_PRIMARY",
  "DESIGNATED_PRIMARY",
  "VERIFIED_CONSENSUS",
  "PAUSED_DISPUTE"
]);

export const teamSideSchema = z.enum(["A", "B"]);
export const clientActionIdSchema = z.string().uuid();

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
  action: scoreCommandSchema
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
  youtubeVideoId: z.string().nullable(),
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
