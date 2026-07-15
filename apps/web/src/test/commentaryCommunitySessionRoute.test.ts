import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const harness = vi.hoisted(() => ({
  commentaryAuthorized: true,
  event: { id: "event-1" } as { id: string } | null,
  court: {
    id: "court-1",
    current_match_id: "match-1",
    scoring_open: true,
    frozen: false
  } as {
    id: string;
    current_match_id: string | null;
    scoring_open: boolean;
    frozen: boolean;
  } | null,
  calls: [] as string[],
  createdInputs: [] as Array<Record<string, unknown>>,
  claimInputs: [] as Array<Record<string, unknown>>,
  createShouldFail: false,
  claimShouldFail: false,
  releaseShouldFail: false,
  existingSessionMode: "missing" as "missing" | "active" | "transient"
}));

vi.mock("@/lib/commentaryAuth", () => ({
  isCommentaryRequest: vi.fn(async () => harness.commentaryAuthorized)
}));

vi.mock("@/lib/eventConfig", () => ({
  getActiveEvent: vi.fn(async () => harness.event),
  getCourtByNumber: vi.fn(async () => harness.court)
}));

vi.mock("@/lib/rateLimit", () => ({ checkRateLimit: vi.fn(() => true) }));
vi.mock("@/lib/security", () => ({ requestIpHash: vi.fn(() => "ip-hash") }));

vi.mock("@/lib/communityWitness", () => {
  class MockCommunityWitnessError extends Error {
    constructor(message: string, public readonly status: number) {
      super(message);
    }
  }
  return {
    CommunityWitnessError: MockCommunityWitnessError,
    communitySessionCookie: "mcs_community_session",
    communitySessionCookieOptions: { httpOnly: true, sameSite: "lax", path: "/" },
    createTrustedCommunityAssignment: vi.fn(async (input: Record<string, unknown>) => {
      harness.calls.push("create");
      if (harness.createShouldFail) throw new Error("claim rejected");
      harness.createdInputs.push(input);
      const assignmentId = `assignment-${harness.createdInputs.length}`;
      return {
        sessionToken: `new-token-${harness.createdInputs.length}`,
        response: {
          assignment: {
            id: assignmentId,
            role: input.role,
            status: "ACTIVE"
          },
          match: { courtNumber: 1 }
        }
      };
    }),
    claimTrustedCommunityDesignatedAssignment: vi.fn(async (input: Record<string, unknown>) => {
      harness.calls.push("claim");
      if (harness.claimShouldFail) throw new Error("claim rejected");
      harness.claimInputs.push(input);
      return {
        sessionToken: input.sessionToken,
        response: {
          assignment: {
            id: "assignment-observer",
            role: "DESIGNATED_SCORER",
            status: "ACTIVE"
          },
          match: { courtNumber: 1 }
        }
      };
    }),
    getCommunitySession: vi.fn(async () => {
      harness.calls.push("get");
      if (harness.existingSessionMode === "transient") throw new Error("temporary database failure");
      if (harness.existingSessionMode === "missing") {
        throw new MockCommunityWitnessError("not found", 404);
      }
      return {
        ok: true,
        duplicate: false,
        assignment: {
          id: "assignment-designated",
          eventId: "event-1",
          courtId: "court-1",
          matchId: "match-1",
          role: "DESIGNATED_SCORER",
          status: "ACTIVE"
        },
        match: { courtNumber: 1 }
      };
    }),
    releaseCommunitySession: vi.fn(async () => {
      harness.calls.push("release");
      if (harness.releaseShouldFail) throw new Error("cleanup failed");
      return {};
    })
  };
});

import { POST } from "../app/api/commentary/scoring/join/route";

const claimActionId = "11111111-1111-4111-8111-111111111111";

function request(
  mode: "view" | "score",
  withExistingSession = false,
  clientActionId: string | null | undefined = mode === "score" ? claimActionId : undefined
): NextRequest {
  return new NextRequest("http://localhost/api/commentary/scoring/join", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(withExistingSession ? { cookie: "mcs_community_session=old-token" } : {})
    },
    body: JSON.stringify({ courtNumber: 1, displayName: "Court Caller", mode, clientActionId })
  });
}

describe("commentary community session join", () => {
  beforeEach(() => {
    harness.commentaryAuthorized = true;
    harness.event = { id: "event-1" };
    harness.court = {
      id: "court-1",
      current_match_id: "match-1",
      scoring_open: true,
      frozen: false
    };
    harness.calls.length = 0;
    harness.createdInputs.length = 0;
    harness.claimInputs.length = 0;
    harness.createShouldFail = false;
    harness.claimShouldFail = false;
    harness.releaseShouldFail = false;
    harness.existingSessionMode = "missing";
  });

  it("creates a remote observer view even when scoring is closed", async () => {
    harness.court!.scoring_open = false;
    harness.court!.frozen = true;

    const response = await POST(request("view"));

    expect(response.status).toBe(200);
    expect(harness.createdInputs).toEqual([
      expect.objectContaining({ role: "OBSERVER", trustTier: "REMOTE", actorLabel: "Commentary viewer" })
    ]);
    expect(response.headers.get("set-cookie")).toContain("mcs_community_session=new-token-1");
  });

  it("requires scoring to be open before creating a remote designated scorer", async () => {
    harness.court!.scoring_open = false;

    const closed = await POST(request("score"));

    expect(closed.status).toBe(409);
    expect(harness.createdInputs).toHaveLength(0);

    harness.court!.scoring_open = true;
    const open = await POST(request("score", true));

    expect(open.status).toBe(200);
    expect(harness.claimInputs[0]).toEqual(expect.objectContaining({
      eventId: "event-1",
      courtId: "court-1",
      matchId: "match-1",
      sessionToken: "old-token",
      actionId: claimActionId,
      actorLabel: "Commentary scorer"
    }));
  });

  it("promotes the current viewer in place without replacing its cookie or media identity", async () => {
    const response = await POST(request("score", true));

    expect(response.status).toBe(200);
    expect(harness.calls).toEqual(["claim"]);
    expect(harness.createdInputs).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("creates a viewer replacement before best-effort release of a prior scoped session", async () => {
    harness.releaseShouldFail = true;

    const response = await POST(request("view", true));

    expect(response.status).toBe(200);
    expect(harness.calls).toEqual(["get", "create", "release"]);
    expect(response.headers.get("set-cookie")).toContain("mcs_community_session=new-token-1");
  });

  it("reuses a live same-match designated session instead of replacing it with an observer", async () => {
    harness.existingSessionMode = "active";

    const response = await POST(request("view", true));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(harness.calls).toEqual(["get"]);
    expect(harness.createdInputs).toHaveLength(0);
    expect(json.assignment.role).toBe("DESIGNATED_SCORER");
    expect(response.headers.get("set-cookie")).toContain("mcs_community_session=old-token");
  });

  it("preserves an ambiguous existing session when the reuse check fails transiently", async () => {
    harness.existingSessionMode = "transient";

    const response = await POST(request("view", true));

    expect(response.status).toBe(500);
    expect(harness.calls).toEqual(["get"]);
    expect(harness.createdInputs).toHaveLength(0);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("leaves the prior viewer cookie and assignment untouched when a scorer claim fails", async () => {
    harness.claimShouldFail = true;

    const response = await POST(request("score", true));

    expect(response.status).toBe(500);
    expect(harness.calls).toEqual(["claim"]);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("requires both the current viewer cookie and a client-stable scorer claim id", async () => {
    const noCookie = await POST(request("score"));
    const noActionId = await POST(request("score", true, null));

    expect(noCookie.status).toBe(409);
    expect(noActionId.status).toBe(400);
    expect(harness.claimInputs).toHaveLength(0);
  });

  it("requires an authenticated commentary session", async () => {
    harness.commentaryAuthorized = false;

    const response = await POST(request("view"));

    expect(response.status).toBe(401);
    expect(harness.createdInputs).toHaveLength(0);
  });
});

describe("commentary court session client contract", () => {
  const client = readFileSync(
    join(process.cwd(), "src/app/commentary/court/[courtNumber]/CommentaryCourtClient.tsx"),
    "utf8"
  );
  const joinRoute = readFileSync(
    join(process.cwd(), "src/app/api/commentary/scoring/join/route.ts"),
    "utf8"
  );

  it("automatically opens a viewer session and explicitly claims a scorer session", () => {
    expect(client).toContain('mode: "view"');
    expect(client).toContain('mode: "score"');
    expect(client).toContain("priorClaim?.assignmentId === communitySession.assignmentId");
    expect(client).toContain("scorerClaimActionRef.current = { assignmentId: communitySession.assignmentId, actionId: clientActionId }");
    expect(client).toContain("clientActionId");
    expect(client).toContain('communitySession.role !== "DESIGNATED_SCORER"');
    expect(client).toContain("Take scorer seat");
  });

  it("keeps the brokered community session mounted and reloads it after assignment replacement", () => {
    const claimStart = client.indexOf("async function startScoring");
    const claimEnd = client.indexOf("\n  return (", claimStart);
    const claimHandler = client.slice(claimStart, claimEnd);

    expect(client).toContain("<CommunityWitnessSessionClient");
    expect(client).toContain('key={`${communitySession.assignmentId}:${communitySession.role}`}');
    expect(client).not.toContain('@/components/StreamPlayer');
    expect(claimHandler).not.toContain("setCommunitySession(null);");
  });

  it("keeps transport latency labels out of the scorekeeper-facing copy", () => {
    expect(client).not.toMatch(/low-latency/i);
    expect(joinRoute).not.toMatch(/low-latency/i);
    expect(client).toContain("Connecting you to the live court feed.");
  });
});
