import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("admin action idempotency contract", () => {
  it("retains client action IDs in the dashboard instead of minting one per fetch attempt", () => {
    const dashboard = source("src/components/EventDashboard.tsx");
    const fanScoringDashboard = source("src/components/fan-scoring/FanScoringDashboard.tsx");
    expect(dashboard).toContain("createClientActionIntentRegistry");
    expect(dashboard).toContain("actionIntents.actionIdFor(intentKey)");
    expect(dashboard).toContain("if (result) actionIntents.complete(intentKey, actionId)");
    expect(dashboard).not.toContain("crypto.randomUUID()");
    expect(fanScoringDashboard).toContain("createClientActionIntentRegistry");
    expect(fanScoringDashboard).toContain('clientIntentKey("community-assignment"');
    expect(fanScoringDashboard).toContain('clientIntentKey("community-dispute"');
    expect(fanScoringDashboard).toContain('clientIntentKey("community-invite"');
    expect(fanScoringDashboard).toContain("JSON.stringify({ action, actionId })");
    expect(fanScoringDashboard).toContain("JSON.stringify({ role, actionId })");
    expect(fanScoringDashboard).not.toContain("crypto.randomUUID()");
  });

  it("requires client UUIDs on every trusted admin mutation route", () => {
    const adminScore = source("src/app/api/courts/[courtId]/admin-score/route.ts");
    const assign = source("src/app/api/courts/[courtId]/assign-match/route.ts");
    const forceNext = source("src/app/api/courts/[courtId]/force-next/route.ts");
    const manualSession = source("src/app/api/events/[eventId]/manual-sessions/route.ts");
    const communityAssignment = source("src/app/api/admin/fan-scoring/assignments/[assignmentId]/route.ts");
    const communityInvite = source("src/app/api/admin/fan-scoring/courts/[courtId]/invites/route.ts");

    expect(adminScore.match(/actionId: z\.string\(\)\.uuid\(\)/g)).toHaveLength(2);
    expect(assign).toContain("z.string().uuid().safeParse(body.actionId)");
    expect(forceNext).toContain("z.string().uuid().safeParse(body.actionId)");
    expect(manualSession).toContain("actionId: z.string().uuid()");
    expect(communityAssignment).toContain("actionId: z.string().uuid()");
    expect(communityAssignment).toContain("actionId: parsed.data.actionId");
    expect(communityInvite).toContain("actionId: randomActionIdSchema");
    expect(communityInvite).toContain("-4[0-9a-f]{3}-[89ab]");
    expect(communityInvite).toContain("actionId: parsed.data.actionId");
    expect(assign).not.toContain("trustedScoreActionId");
    expect(forceNext).not.toContain("trustedScoreActionId");
  });

  it("does not mint retry IDs inside assignment RPC wrappers", () => {
    const witness = source("src/lib/communityWitness.ts");
    for (const functionName of [
      "promoteCommunityAssignment",
      "verifyCommunityAssignment",
      "endCommunityAssignment"
    ]) {
      const start = witness.indexOf(`export function ${functionName}`);
      const end = witness.indexOf("\n}\n", start) + 3;
      expect(start).toBeGreaterThan(0);
      expect(witness.slice(start, end)).toContain("z.string().uuid().parse(input.actionId)");
      expect(witness.slice(start, end)).not.toContain("crypto.randomUUID()");
    }
  });

  it("derives one-use invite secrets from the stable client intent", () => {
    const witness = source("src/lib/communityWitness.ts");
    const start = witness.indexOf("export async function createCommunityJoinGrant");
    const end = witness.indexOf("\n}\n", start) + 3;
    const wrapper = witness.slice(start, end);

    expect(wrapper).toContain("const joinCode = randomActionIdSchema.parse(input.actionId).toLowerCase()");
    expect(wrapper).toContain("p_action_id: joinCode");
    expect(wrapper).toContain("p_token_hash: hashToken(joinCode)");
    expect(wrapper).not.toContain("generateSessionToken()");
  });

  it("does not let a force-next retry mutate a newly recomputed target", () => {
    const forceNext = source("src/app/api/courts/[courtId]/force-next/route.ts");
    const duplicateGuard = forceNext.indexOf("transition.duplicate && transition.newMatchId !== next.match_id");
    const queueMutation = forceNext.indexOf("if (active) {", duplicateGuard);
    expect(duplicateGuard).toBeGreaterThan(0);
    expect(queueMutation).toBeGreaterThan(duplicateGuard);
  });
});
