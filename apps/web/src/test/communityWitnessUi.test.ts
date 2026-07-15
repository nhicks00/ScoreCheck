import { describe, expect, it } from "vitest";
import { parsePendingContribution } from "../app/score/session/communityWitnessApi";
import { requestedCommunityRole } from "../app/score/court/[courtId]/communityJoinUi";
import {
  DEFAULT_SIDE_ORDER,
  adaptCommunityWitnessState,
  canRemovePointFromScore,
  canSubmitContribution,
  communityRetryPlan,
  communitySyncDelayMs,
  communitySyncJitterMs,
  contributionRallyNumber,
  freshestCommunitySnapshot,
  journeyWithReceipt,
  matchSideOrderStorageKey,
  parseStoredSideOrder,
  reconciledReceiptFromSnapshot,
  receiptFromSnapshot,
  retryableContributionReceipt,
  successfulContributionReceipt,
  swapSideOrder,
  type CommunitySessionSnapshot
} from "../app/score/session/communityWitnessUi";

describe("community witness scorer UI adapter", () => {
  it("keeps canonical team IDs while presenting real names and the broadcast score", () => {
    const view = adaptCommunityWitnessState(snapshot());

    expect(view.courtLabel).toBe("Court 4");
    expect(view.matchLabel).toBe("Match 12");
    expect(view.currentSet).toBe(2);
    expect(view.teams.A).toMatchObject({ id: "A", name: "Basey / Hurst", score: 18, tone: "blue" });
    expect(view.teams.B).toMatchObject({ id: "B", name: "Caldwell / Labouliere", score: 16, tone: "red" });
    expect(view.coverageLabel).toBe("8 witnesses · 7 rallies confirmed together");
    expect(view.personalSummary).toEqual({ contributionsRecorded: 18, confirmedCalls: 14, reviewTriggers: 1, correctionsHelped: 1 });
  });

  it("does not claim an unobserved rally is confirmed or on the broadcast", () => {
    const view = adaptCommunityWitnessState(snapshot());

    expect(view.rallyJourney).toEqual([
      { rallyNumber: 34, status: "confirmed" },
      { rallyNumber: 35, status: "corrected" },
      { rallyNumber: 36, status: "confirmed" },
      { rallyNumber: 37, status: "voided" },
      { rallyNumber: 38, status: "pending" }
    ]);
  });

  it("keeps ordinary observation receipts truthful until resolution", () => {
    const input = snapshot();
    input.receipt = null;
    input.community.latestReceipt = null;

    expect(receiptFromSnapshot(input, 39, false)).toMatchObject({
      status: "recorded",
      message: "Rally 39 recorded · awaiting resolution"
    });

    input.assignment.role = "DESIGNATED_SCORER";
    input.score.authorityMode = "DESIGNATED_PRIMARY";
    expect(receiptFromSnapshot(input, 39, false)).toMatchObject({
      status: "confirmed",
      message: "Rally 39 recorded · broadcast updated"
    });
  });

  it("scopes and validates local-only side order without changing team IDs", () => {
    expect(matchSideOrderStorageKey("match-12")).toBe("scorecheck:community-side-order:match-12");
    expect(swapSideOrder(DEFAULT_SIDE_ORDER)).toEqual(["B", "A"]);
    expect(parseStoredSideOrder('["B","A"]')).toEqual(["B", "A"]);
    expect(parseStoredSideOrder('["A","A"]')).toEqual(["A", "B"]);
    expect(parseStoredSideOrder("not-json")).toEqual(["A", "B"]);
  });

  it("adds a pending local receipt to the journey without fabricating confirmation", () => {
    expect(journeyWithReceipt(
      [{ rallyNumber: 37, status: "confirmed" }],
      { rallyNumber: 38, status: "sending", message: "Sending…" }
    )).toEqual([
      { rallyNumber: 37, status: "confirmed" },
      { rallyNumber: 38, status: "pending" }
    ]);
  });

  it("does not turn a personal differed receipt into a global review journey", () => {
    expect(journeyWithReceipt(
      [{ rallyNumber: 38, status: "confirmed" }],
      { rallyNumber: 38, status: "differed", message: "Rally 38 resolved differently." }
    )).toEqual([{ rallyNumber: 38, status: "confirmed" }]);

    expect(journeyWithReceipt(
      [{ rallyNumber: 38, status: "corrected" }],
      { rallyNumber: 38, status: "corrected", message: "You contributed to the correction." }
    )).toEqual([{ rallyNumber: 38, status: "corrected" }]);
  });

  it("only grants command controls to the designated scorer under designated authority", () => {
    const input = snapshot();
    expect(canSubmitContribution(input, "ADD_POINT")).toBe(true);

    input.assignment.role = "DESIGNATED_SCORER";
    input.score.authorityMode = "PROVIDER_PRIMARY";
    expect(canSubmitContribution(input, "ADD_POINT")).toBe(false);

    input.score.authorityMode = "DESIGNATED_PRIMARY";
    expect(canSubmitContribution(input, "ADD_POINT")).toBe(true);
  });

  it("waits for the score to advance after an observer contributes to the current revision", () => {
    const input = snapshot();
    input.community.hasContributedToCurrentRevision = true;

    expect(canSubmitContribution(input, "ADD_POINT")).toBe(false);
    expect(canSubmitContribution(input, "REMOVE_POINT")).toBe(false);

    input.score.revision += 1;
    input.community.hasContributedToCurrentRevision = false;
    expect(canSubmitContribution(input, "ADD_POINT")).toBe(true);
  });

  it("allows a remove correction to reopen the latest completed set or final", () => {
    const input = snapshot();
    input.score.status = "Final";
    input.score.teamAScore = 0;
    input.score.teamBScore = 0;
    input.score.setScores = [{ setNumber: 3, teamAScore: 15, teamBScore: 13, isComplete: true }];

    expect(canSubmitContribution(input, "ADD_POINT")).toBe(false);
    expect(canSubmitContribution(input, "REMOVE_POINT")).toBe(true);
    expect(canRemovePointFromScore(input.score, "A")).toBe(true);
    expect(canRemovePointFromScore(input.score, "B")).toBe(true);
  });

  it("does not offer a previous-set correction while the current set is partially played", () => {
    const input = snapshot();
    input.score.teamAScore = 0;
    input.score.teamBScore = 1;
    input.score.setScores = [{ setNumber: 1, teamAScore: 21, teamBScore: 17, isComplete: true }];

    expect(canRemovePointFromScore(input.score, "A")).toBe(false);
    expect(canRemovePointFromScore(input.score, "B")).toBe(true);
  });

  it("numbers an added point as the next rally and a correction as the current rally", () => {
    expect(contributionRallyNumber(38, "ADD_POINT")).toBe(39);
    expect(contributionRallyNumber(38, "REMOVE_POINT")).toBe(38);
    expect(contributionRallyNumber(0, "ADD_POINT")).toBe(1);
  });

  it("keeps a brand-new score at canonical Rally 0 so its first add is Rally 1", () => {
    const input = snapshot();
    input.score.currentRallyNumber = 0;
    input.community.currentRallyNumber = 0;
    input.score.teamAScore = 0;
    input.score.teamBScore = 0;
    input.community.recentRallies = [];

    const view = adaptCommunityWitnessState(input);
    expect(view.currentRallyNumber).toBe(0);
    expect(view.rallyJourney).toEqual([]);
    expect(contributionRallyNumber(view.currentRallyNumber, "ADD_POINT")).toBe(1);
  });

  it("uses one adaptive lease-and-snapshot sync instead of stacked polling", () => {
    expect(communitySyncDelayMs({ visible: true, fastUntil: 20_000, now: 15_000 })).toBe(2_000);
    expect(communitySyncDelayMs({ visible: true, fastUntil: 10_000, now: 15_000 })).toBe(8_000);
    expect(communitySyncDelayMs({ visible: false, fastUntil: 20_000, now: 15_000 })).toBe(30_000);
    expect(communitySyncJitterMs("assignment-1")).toBe(communitySyncJitterMs("assignment-1"));
    expect(communitySyncJitterMs("assignment-1")).toBeGreaterThanOrEqual(0);
    expect(communitySyncJitterMs("assignment-1")).toBeLessThan(750);
  });

  it("bounds automatic contribution retries and leaves offline/manual recovery explicit", () => {
    expect(communityRetryPlan(1, true)).toEqual({ mode: "scheduled", retryAfterMs: 1_000 });
    expect(communityRetryPlan(2, true)).toEqual({ mode: "scheduled", retryAfterMs: 2_000 });
    expect(communityRetryPlan(5, true)).toEqual({ mode: "scheduled", retryAfterMs: 16_000 });
    expect(communityRetryPlan(6, true)).toEqual({ mode: "manual", retryAfterMs: null });
    expect(communityRetryPlan(1, false)).toEqual({ mode: "offline", retryAfterMs: null });
    expect(retryableContributionReceipt(39, false, "scheduled")).toMatchObject({
      status: "retrying",
      message: "Rally 39 saved on this screen · retrying shortly"
    });
  });

  it("uses a successful action receipt even when a later-lease heartbeat wins snapshot freshness", () => {
    const actionResponse = snapshot();
    actionResponse.receipt = {
      id: "receipt-action",
      rallyNumber: 39,
      status: "CONFIRMED",
      message: "You helped confirm Rally 39.",
      canonicalRevision: 23,
      resolvedAt: "2026-07-14T12:01:00.000Z"
    };
    actionResponse.community.latestReceipt = actionResponse.receipt;
    const heartbeat = structuredClone(actionResponse);
    heartbeat.assignment.leaseExpiresAt = "2026-07-14T13:05:00.000Z";

    expect(freshestCommunitySnapshot(heartbeat, actionResponse)).toBe(heartbeat);
    expect(successfulContributionReceipt(actionResponse, 39, false, false)).toMatchObject({
      status: "confirmed",
      message: "You helped confirm Rally 39."
    });
  });

  it("reconciles recorded engagement feedback to its resolved heartbeat receipt", () => {
    const confirmed = snapshot();
    confirmed.community.latestReceipt = {
      id: "receipt-action",
      rallyNumber: 39,
      status: "CONFIRMED",
      message: "You helped confirm Rally 39.",
      canonicalRevision: 23,
      resolvedAt: "2026-07-14T12:01:00.000Z"
    };
    const recorded = { rallyNumber: 39, status: "recorded" as const, message: "Call recorded · waiting for the score to advance" };

    expect(reconciledReceiptFromSnapshot(recorded, false, confirmed)).toMatchObject({
      status: "confirmed",
      message: "You helped confirm Rally 39."
    });
    expect(reconciledReceiptFromSnapshot(recorded, true, confirmed)).toBe(recorded);
  });

  it("preserves a failed action receipt through refresh and heartbeat until explicit acknowledgement", () => {
    const confirmed = snapshot();
    confirmed.community.latestReceipt = {
      id: "receipt-previous",
      rallyNumber: 38,
      status: "CONFIRMED",
      message: "You helped confirm Rally 38.",
      canonicalRevision: 22,
      resolvedAt: "2026-07-14T12:01:00.000Z"
    };
    const failed = {
      rallyNumber: 39,
      status: "failed" as const,
      message: "Rally 39 was not recorded · try again"
    };

    const afterQuietRefresh = reconciledReceiptFromSnapshot(failed, false, confirmed, true);
    const afterHeartbeat = reconciledReceiptFromSnapshot(afterQuietRefresh, false, confirmed, true);

    expect(afterQuietRefresh).toBe(failed);
    expect(afterHeartbeat).toBe(failed);
    expect(reconciledReceiptFromSnapshot(afterHeartbeat, false, confirmed, false)).toMatchObject({
      status: "confirmed",
      message: "You helped confirm Rally 38."
    });
  });

  it("does not claim the broadcast is current while canonical projection is retrying", () => {
    const input = snapshot();
    input.assignment.role = "DESIGNATED_SCORER";
    input.score.authorityMode = "DESIGNATED_PRIMARY";
    input.projectionStatus = "RETRYING";

    expect(successfulContributionReceipt(input, 39, false, false)).toEqual({
      rallyNumber: 39,
      status: "recorded",
      message: "Rally 39 saved · broadcast catching up"
    });
  });

  it("does not let an older poll erase a contribution receipt at the same score revision", () => {
    const accepted = snapshot();
    accepted.community.personalSummary.contributionsRecorded = 19;
    accepted.community.latestReceipt = {
      id: "receipt-2",
      rallyNumber: 39,
      status: "RECORDED",
      message: "Recorded",
      canonicalRevision: null,
      resolvedAt: null
    };
    const stalePoll = snapshot();

    expect(freshestCommunitySnapshot(accepted, stalePoll)).toBe(accepted);
  });

  it("accepts a newer resolved receipt without requiring another score revision", () => {
    const recorded = snapshot();
    recorded.community.latestReceipt = {
      id: "receipt-2",
      rallyNumber: 38,
      status: "RECORDED",
      message: "Recorded",
      canonicalRevision: null,
      resolvedAt: null
    };
    const confirmed = structuredClone(recorded);
    confirmed.community.latestReceipt = { ...recorded.community.latestReceipt, status: "CONFIRMED", canonicalRevision: 22 };

    expect(freshestCommunitySnapshot(recorded, confirmed)).toBe(confirmed);
  });

  it("accepts a later dismissal of a triggered review at the same score revision", () => {
    const review = snapshot();
    review.community.latestReceipt = {
      id: "receipt-review",
      rallyNumber: 38,
      status: "TRIGGERED_REVIEW",
      message: "Your call opened a review.",
      canonicalRevision: 22,
      resolvedAt: null
    };
    const dismissed = structuredClone(review);
    dismissed.community.latestReceipt = {
      ...review.community.latestReceipt,
      status: "DIFFERED",
      message: "Review complete · the official call was kept.",
      resolvedAt: "2026-07-14T12:02:00.000Z"
    };

    expect(freshestCommunitySnapshot(review, dismissed)).toBe(dismissed);
  });

  it("restores only structurally valid stable outbox actions", () => {
    const pending = {
      clientActionId: "550e8400-e29b-41d4-a716-446655440000",
      kind: "observation",
      type: "ADD_POINT",
      team: "B",
      baseRevision: 22,
      rallyNumber: 39,
      deviceSequence: 7,
      createdAt: "2026-07-14T12:00:00.000Z",
      requiresLiveMedia: false,
      deliveryUncertain: false
    };

    expect(parsePendingContribution(JSON.stringify(pending))).toEqual(pending);
    expect(parsePendingContribution(JSON.stringify({ ...pending, team: "LEFT" }))).toBeNull();
  });

  it("does not turn a verified-witness grant into designated authority without explicit intent", () => {
    expect(requestedCommunityRole("verified-grant", undefined)).toBe("OBSERVER");
    expect(requestedCommunityRole("verified-grant", "witness")).toBe("OBSERVER");
    expect(requestedCommunityRole(undefined, "designated")).toBe("OBSERVER");
    expect(requestedCommunityRole("designated-grant", "designated")).toBe("DESIGNATED_SCORER");
  });
});

function snapshot(): CommunitySessionSnapshot {
  return {
    ok: true,
    assignment: {
      id: "assignment-1",
      eventId: "event-1",
      courtId: "court-4",
      matchId: "match-12",
      displayName: "Courtside witness",
      role: "OBSERVER",
      trustTier: "COURTSIDE",
      status: "ACTIVE",
      authorityEpoch: 3,
      leaseExpiresAt: "2026-07-14T13:00:00.000Z"
    },
    match: {
      id: "match-12",
      eventId: "event-1",
      courtId: "court-4",
      courtNumber: 4,
      courtName: "Court 4",
      teamAName: "Basey / Hurst",
      teamBName: "Caldwell / Labouliere",
      matchNumber: "12",
      roundName: "Quarterfinal",
      format: { bestOf: 3 }
    },
    score: {
      revision: 22,
      authorityEpoch: 3,
      authorityMode: "PROVIDER_PRIMARY",
      stateHash: "hash",
      teamAScore: 18,
      teamBScore: 16,
      teamASets: 1,
      teamBSets: 0,
      currentSet: 2,
      setScores: [{ setNumber: 1, teamAScore: 21, teamBScore: 17, isComplete: true }],
      servingTeam: "A",
      timeouts: {},
      status: "In Progress",
      currentRallyNumber: 38,
      updatedAt: "2026-07-14T12:00:00.000Z"
    },
    receipt: null,
    community: {
      currentRallyNumber: 38,
      witnessCount: 8,
      confirmedTogether: 7,
      hasContributedToCurrentRevision: false,
      recentRallies: [
        { rallyNumber: 34, status: "CONFIRMED" },
        { rallyNumber: 35, status: "CORRECTED" },
        { rallyNumber: 36, status: "CONFIRMED" },
        { rallyNumber: 37, status: "VOIDED" },
        { rallyNumber: 38, status: "UNOBSERVED" }
      ],
      latestReceipt: null,
      personalSummary: {
        contributionsRecorded: 18,
        confirmedCalls: 14,
        reviewTriggers: 1,
        correctionsHelped: 1
      }
    }
  };
}
