import { describe, expect, it } from "vitest";
import {
  communitySessionCookie,
  communitySessionCookieOptions
} from "../lib/communityWitness";
import {
  communitySessionResponseSchema,
  joinCommunitySchema,
  observationSchema,
  scoreCommandSchema
} from "../lib/communityWitnessSchemas";

const validResponse = {
  ok: true,
  duplicate: false,
  eventId: null,
  outboxId: null,
  assignment: {
    id: "00000000-0000-4000-8000-000000000001",
    eventId: "00000000-0000-4000-8000-000000000002",
    courtId: "00000000-0000-4000-8000-000000000003",
    matchId: "00000000-0000-4000-8000-000000000004",
    displayName: "Casey",
    role: "OBSERVER",
    trustTier: "REMOTE",
    status: "ACTIVE",
    authorityEpoch: 1,
    leaseExpiresAt: "2026-07-14T20:00:00.000Z"
  },
  match: {
    id: "00000000-0000-4000-8000-000000000004",
    eventId: "00000000-0000-4000-8000-000000000002",
    courtId: "00000000-0000-4000-8000-000000000003",
    courtNumber: 1,
    courtName: "Championship Court",
    teamAName: "Hicks / Smith",
    teamBName: "Jones / Lee",
    matchNumber: "M12",
    roundName: "Final",
    format: { bestOf: 3 }
  },
  score: {
    revision: 0,
    authorityEpoch: 1,
    authorityMode: "PAUSED_DISPUTE",
    stateHash: "a".repeat(64),
    teamAScore: 0,
    teamBScore: 0,
    teamASets: 0,
    teamBSets: 0,
    currentSet: 1,
    setScores: [],
    servingTeam: null,
    timeouts: {},
    status: "Pre-Match",
    currentRallyNumber: 0,
    updatedAt: "2026-07-14T19:59:00.000Z"
  },
  receipt: null,
  community: {
    currentRallyNumber: 0,
    witnessCount: 1,
    confirmedTogether: 0,
    hasContributedToCurrentRevision: false,
    recentRallies: [],
    latestReceipt: null,
    personalSummary: {
      contributionsRecorded: 0,
      confirmedCalls: 0,
      reviewTriggers: 0,
      correctionsHelped: 0
    }
  }
} as const;

describe("community witness public contracts", () => {
  it("keeps public observer joins remote even when optional fields are omitted", () => {
    expect(joinCommunitySchema.parse({
      eventSlug: "avp-denver",
      courtNumber: 1,
      displayName: "Casey"
    })).toMatchObject({ participationMode: "REMOTE", requestedRole: "OBSERVER" });
  });

  it("accepts only explicit add and subtract observations", () => {
    expect(observationSchema.parse({ type: "ADD_POINT", team: "A" })).toEqual({ type: "ADD_POINT", team: "A" });
    expect(observationSchema.parse({ type: "REMOVE_POINT", team: "B" })).toEqual({ type: "REMOVE_POINT", team: "B" });
    expect(observationSchema.safeParse({ type: "UNSURE", team: "A" }).success).toBe(false);
    expect(observationSchema.safeParse({ type: "NO_POINT", team: "A" }).success).toBe(false);
  });

  it("requires strict command payloads", () => {
    expect(scoreCommandSchema.safeParse({ type: "ADD_POINT", team: "A", hidden: true }).success).toBe(false);
    expect(scoreCommandSchema.safeParse({ type: "REMOVE_POINT", team: "A" }).success).toBe(true);
    expect(scoreCommandSchema.safeParse({ type: "SET_CURRENT_SET", set: 2 }).success).toBe(true);
    expect(scoreCommandSchema.safeParse({ type: "SET_CURRENT_SET", set: 0 }).success).toBe(false);
    expect(scoreCommandSchema.safeParse({ type: "SET_CURRENT_SET", set: 2, team: "A" }).success).toBe(false);
  });

  it("parses the complete safe DTO but rejects a leaked session token", () => {
    expect(communitySessionResponseSchema.safeParse(validResponse).success).toBe(true);
    expect(communitySessionResponseSchema.safeParse({ ...validResponse, sessionToken: "secret" }).success).toBe(false);
  });

  it("keeps every media path, credential, and provider identifier out of the match DTO", () => {
    expect(communitySessionResponseSchema.safeParse({
      ...validResponse,
      match: { ...validResponse.match, previewStreamPath: "court1_preview" }
    }).success).toBe(false);
    expect(communitySessionResponseSchema.safeParse({
      ...validResponse,
      match: { ...validResponse.match, youtubeVideoId: "abc123_PUBLIC" }
    }).success).toBe(false);
  });

  it("uses a private, same-site, twelve-hour session cookie", () => {
    expect(communitySessionCookie).toBe("mcs_community_session");
    expect(communitySessionCookieOptions).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 12 * 60 * 60
    });
  });

  it("maps an inactive community session to a terminal gone response", async () => {
    const { communityErrorStatus } = await import("../lib/communityWitness");
    expect(communityErrorStatus("P0003")).toBe(410);
    expect(communityErrorStatus("P0004")).toBe(429);
    expect(communityErrorStatus("40001")).toBe(409);
    expect(communityErrorStatus("55000")).toBe(409);
  });
});
