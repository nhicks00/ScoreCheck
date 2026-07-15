import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("community admission boundary", () => {
  it("persists a private device cookie on every join response path", () => {
    const route = source("src/app/api/community/join/route.ts");

    expect(route).toContain("deviceIdFromCookieOrCreate(req)");
    expect(route).toContain("response.cookies.set(communityDeviceCookie, device.raw, communityDeviceCookieOptions)");
    expect(route).not.toMatch(/return NextResponse\.json/);
    expect(route).toContain("return respond(communityApiError(error))");
  });

  it("commits durable quota before join and sends IP only to the quota RPC", () => {
    const route = source("src/app/api/community/join/route.ts");
    const witness = source("src/lib/communityWitness.ts");
    const quotaCall = route.indexOf("await consumeCommunityAdmissionQuota");
    const joinCall = route.indexOf("await joinCommunity");
    const joinStart = witness.indexOf("export async function joinCommunity");
    const joinEnd = witness.indexOf("\n}\n", joinStart) + 3;
    const joinWrapper = witness.slice(joinStart, joinEnd);

    expect(quotaCall).toBeGreaterThan(0);
    expect(joinCall).toBeGreaterThan(quotaCall);
    expect(route).toContain("if (!quota.allowed)");
    expect(joinWrapper).toContain("p_device_token_hash");
    expect(joinWrapper).not.toContain("p_ip_hash");
  });

  it("does not release the previous session until the replacement join succeeds", () => {
    const route = source("src/app/api/community/join/route.ts");
    const joinCall = route.indexOf("await joinCommunity");
    const releaseCall = route.indexOf("await releaseCommunitySession");
    expect(joinCall).toBeGreaterThan(0);
    expect(releaseCall).toBeGreaterThan(joinCall);
  });
});
