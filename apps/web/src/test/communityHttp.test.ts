import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommunitySessionResponse } from "../lib/communityWitnessSchemas";

const mocks = vi.hoisted(() => ({
  publishCanonicalScoreOutbox: vi.fn()
}));

vi.mock("../lib/scoreState", () => ({
  publishCanonicalScoreOutbox: mocks.publishCanonicalScoreOutbox
}));

import { CommunityWitnessError } from "../lib/communityWitness";
import { communityApiError, communityMutationResponse } from "../lib/communityHttp";

const response = {
  ok: true,
  duplicate: false,
  eventId: "00000000-0000-4000-8000-000000000005",
  outboxId: "00000000-0000-4000-8000-000000000006",
  assignment: {
    id: "00000000-0000-4000-8000-000000000001",
    eventId: "00000000-0000-4000-8000-000000000002",
    courtId: "00000000-0000-4000-8000-000000000003",
    matchId: "00000000-0000-4000-8000-000000000004",
    displayName: "Casey",
    role: "DESIGNATED_SCORER",
    trustTier: "VERIFIED_COURTSIDE",
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
    revision: 1,
    authorityEpoch: 1,
    authorityMode: "DESIGNATED_PRIMARY",
    stateHash: "a".repeat(64),
    teamAScore: 1,
    teamBScore: 0,
    teamASets: 0,
    teamBSets: 0,
    currentSet: 1,
    setScores: [],
    servingTeam: null,
    timeouts: {},
    status: "In Progress",
    currentRallyNumber: 1,
    updatedAt: "2026-07-14T19:59:00.000Z"
  },
  receipt: null,
  community: {
    currentRallyNumber: 1,
    witnessCount: 1,
    confirmedTogether: 0,
    hasContributedToCurrentRevision: false,
    recentRallies: [{ rallyNumber: 1, status: "CONFIRMED" }],
    latestReceipt: null,
    personalSummary: {
      contributionsRecorded: 1,
      confirmedCalls: 1,
      reviewTriggers: 0,
      correctionsHelped: 0
    }
  }
} satisfies CommunitySessionResponse;

describe("community mutation outbox handoff", () => {
  beforeEach(() => {
    mocks.publishCanonicalScoreOutbox.mockReset();
  });

  it("publishes a canonical outbox item before returning success", async () => {
    mocks.publishCanonicalScoreOutbox.mockResolvedValue(undefined);

    const httpResponse = await communityMutationResponse(response);

    expect(mocks.publishCanonicalScoreOutbox).toHaveBeenCalledWith({ outboxId: response.outboxId });
    expect(httpResponse.status).toBe(200);
    expect(await httpResponse.json()).toMatchObject({ projectionStatus: "PUBLISHED", outboxId: response.outboxId });
  });

  it("acknowledges the durable commit with 202 when projection will retry", async () => {
    mocks.publishCanonicalScoreOutbox.mockRejectedValue(new Error("temporary projection failure"));

    const httpResponse = await communityMutationResponse(response);

    expect(httpResponse.status).toBe(202);
    expect(await httpResponse.json()).toMatchObject({ projectionStatus: "RETRYING", outboxId: response.outboxId });
  });

  it("skips outbox work for an observation-only contribution", async () => {
    const httpResponse = await communityMutationResponse({ ...response, eventId: null, outboxId: null });

    expect(mocks.publishCanonicalScoreOutbox).not.toHaveBeenCalled();
    expect(httpResponse.status).toBe(200);
    expect(await httpResponse.json()).toMatchObject({ projectionStatus: "NOT_REQUIRED", outboxId: null });
  });
});

describe("community HTTP error boundary", () => {
  it.each([
    ["P0003", 410, "This scoring session has ended."],
    ["P0004", 429, "active contributor limit"],
    ["28000", 403, "invalid, expired, or no longer available"],
    ["40001", 409, "changed first"],
    ["22023", 400, "not valid"]
  ])("maps SQLSTATE %s without exposing database detail", async (code, status, publicMessage) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = `raw database detail for ${code}: private_constraint_name`;
    const response = communityApiError(new CommunityWitnessError(raw, status, code));
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.error).toContain(publicMessage);
    expect(body.error).not.toContain(raw);
    expect(log).toHaveBeenCalledWith("Community scoring request rejected", expect.objectContaining({ code, message: raw }));
    log.mockRestore();
  });

  it("does not expose unique constraint names on conflicts", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = communityApiError(new CommunityWitnessError(
      'duplicate key violates unique constraint "community_assignments_one_designated_idx"',
      409,
      "23505"
    ));

    expect(await response.json()).toMatchObject({
      error: "The score or court changed first. Refresh and try again.",
      code: "23505"
    });
    log.mockRestore();
  });
});
