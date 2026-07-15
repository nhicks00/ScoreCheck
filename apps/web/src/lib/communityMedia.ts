import { z } from "zod";
import { getEnv } from "./env";
import { hashToken } from "./security";
import { supabaseAdmin } from "./supabase";
import { CommunityWitnessError, communityErrorStatus } from "./communityWitness";

const mediaResourceSchema = z.object({
  id: z.string().uuid(),
  upstreamResourceUrl: z.string().nullable(),
  upstreamAffinityCookie: z.string().nullable()
}).strict();

const cleanupResourceSchema = mediaResourceSchema.extend({
  cleanupClaimToken: z.string().uuid()
}).strict();

const reservationSchema = z.object({
  id: z.string().uuid(),
  assignmentId: z.string().uuid(),
  eventId: z.string().uuid(),
  courtId: z.string().uuid(),
  matchId: z.string().uuid(),
  courtNumber: z.number().int().positive(),
  previewStreamPath: z.string().nullable(),
  expiresAt: z.string(),
  replaced: mediaResourceSchema.nullable()
}).strict();

const activationSchema = z.object({
  ok: z.literal(true),
  id: z.string().uuid(),
  expiresAt: z.string()
}).strict();

const pruneSummarySchema = z.object({
  playbackEvidenceDeleted: z.number().int().min(0),
  mediaSessionsDeleted: z.number().int().min(0)
}).strict();

export type CommunityMediaCleanupResource = z.infer<typeof cleanupResourceSchema>;
export type CommunityMediaReservation = z.infer<typeof reservationSchema>;
export type CommunityMediaHistoryPruneSummary = z.infer<typeof pruneSummarySchema>;

async function mediaRpc<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await supabaseAdmin().rpc(name, args);
  if (error) {
    throw new CommunityWitnessError(error.message, communityErrorStatus(error.code), error.code);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new CommunityWitnessError(`Invalid ${name} response: ${parsed.error.message}`, 500, "INVALID_RPC_RESPONSE");
  }
  return parsed.data;
}

async function mediaVoidRpc(name: string, args: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin().rpc(name, args);
  if (error) throw new CommunityWitnessError(error.message, communityErrorStatus(error.code), error.code);
}

export function reserveCommunityMediaSession(sessionToken: string): Promise<CommunityMediaReservation> {
  const env = getEnv();
  return mediaRpc("community_reserve_media_session", {
    p_session_token_hash: hashToken(sessionToken),
    p_max_per_court: env.communityMediaMaxPerCourt,
    p_max_total: env.communityMediaMaxTotal,
    p_lease_seconds: env.communityMediaSessionSeconds
  }, reservationSchema);
}

export function activateCommunityMediaSession(input: {
  sessionToken: string;
  mediaSessionId: string;
  upstreamResourceUrl: string;
  upstreamAffinityCookie: string | null;
}): Promise<z.infer<typeof activationSchema>> {
  return mediaRpc("community_activate_media_session", {
    p_session_token_hash: hashToken(input.sessionToken),
    p_media_session_id: z.string().uuid().parse(input.mediaSessionId),
    p_upstream_resource_url: z.string().url().max(4096).parse(input.upstreamResourceUrl),
    p_upstream_affinity_cookie: input.upstreamAffinityCookie
  }, activationSchema);
}

export function failCommunityMediaSession(input: {
  mediaSessionId: string;
  error?: string;
  upstreamResource?: {
    upstreamResourceUrl: string;
    upstreamAffinityCookie: string | null;
  } | null;
}): Promise<void> {
  return mediaVoidRpc("community_fail_media_session", {
    p_media_session_id: z.string().uuid().parse(input.mediaSessionId),
    p_error: input.error?.slice(0, 500) ?? null,
    p_upstream_resource_url: input.upstreamResource?.upstreamResourceUrl ?? null,
    p_upstream_affinity_cookie: input.upstreamResource?.upstreamAffinityCookie ?? null
  });
}

export async function touchCommunityMediaSessions(sessionToken: string): Promise<number> {
  const env = getEnv();
  return mediaRpc("community_touch_media_sessions", {
    p_session_token_hash: hashToken(sessionToken),
    p_lease_seconds: env.communityMediaSessionSeconds
  }, z.number().int().min(0));
}

export async function requestCommunityMediaSessionClose(sessionToken: string): Promise<number> {
  return mediaRpc("community_request_media_session_close", {
    p_session_token_hash: hashToken(sessionToken)
  }, z.number().int().min(0));
}

export async function claimCommunityMediaSessionClose(input: {
  sessionToken: string;
  mediaSessionId: string;
  claimedBy: string;
}): Promise<CommunityMediaCleanupResource | null> {
  const cleanupClaimToken = crypto.randomUUID();
  return mediaRpc("community_claim_media_session_close", {
    p_session_token_hash: hashToken(input.sessionToken),
    p_media_session_id: z.string().uuid().parse(input.mediaSessionId),
    p_claimed_by: z.string().trim().min(1).max(120).parse(input.claimedBy),
    p_cleanup_claim_token: cleanupClaimToken,
    p_lease_seconds: 30
  }, cleanupResourceSchema.nullable());
}

export async function claimCommunityMediaCleanup(input: {
  workerId: string;
  limit?: number;
}): Promise<CommunityMediaCleanupResource[]> {
  const cleanupClaimToken = crypto.randomUUID();
  return mediaRpc("community_claim_media_cleanup", {
    p_worker_id: z.string().trim().min(1).max(120).parse(input.workerId),
    p_cleanup_claim_token: cleanupClaimToken,
    p_limit: z.number().int().min(1).max(100).parse(input.limit ?? 20),
    // The worker deletes in bounded parallel batches. Keep the claim through
    // several full upstream timeout windows so another worker cannot reclaim
    // the tail of this batch while it is still being processed.
    p_lease_seconds: 120
  }, z.array(cleanupResourceSchema));
}

export function finishCommunityMediaCleanup(input: {
  mediaSessionId: string;
  claimedBy: string;
  cleanupClaimToken: string;
  succeeded: boolean;
  error?: string;
}): Promise<void> {
  return mediaVoidRpc("community_finish_media_cleanup", {
    p_media_session_id: z.string().uuid().parse(input.mediaSessionId),
    p_claimed_by: z.string().trim().min(1).max(120).parse(input.claimedBy),
    p_cleanup_claim_token: z.string().uuid().parse(input.cleanupClaimToken),
    p_succeeded: input.succeeded,
    p_error: input.error?.slice(0, 500) ?? null
  });
}

export function pruneCommunityMediaHistory(limit = 500): Promise<CommunityMediaHistoryPruneSummary> {
  return mediaRpc("community_prune_media_history", {
    p_limit: z.number().int().min(1).max(5_000).parse(limit)
  }, pruneSummarySchema);
}
