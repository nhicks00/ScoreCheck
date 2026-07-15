import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sessionClient = read("src/app/score/session/CommunityWitnessSessionClient.tsx");
const observationRoute = read("src/app/api/community/session/observations/route.ts");
const adminRoute = read("src/app/api/courts/[courtId]/admin-score/route.ts");
const setMigration = read("supabase/migrations/027_canonical_current_set_command.sql");

describe("community scorekeeping hard-cut contracts", () => {
  it("uses court-scoped realtime only as an authenticated snapshot invalidation", () => {
    expect(sessionClient).toContain("createOverlayInvalidationScheduler");
    expect(sessionClient).toContain("invalidationOnlyBroadcastHandler");
    expect(sessionClient).toContain("`overlay:${eventId}:court:${courtNumber}`");
    expect(sessionClient).toContain("refresh({ quiet: true })");
  });

  it("never turns an uncertain remote point into a delayed new submission", () => {
    expect(sessionClient).toContain("isPendingCommandRecorded");
    expect(sessionClient).toContain("deliveryUncertain: true");
    expect(sessionClient).toContain("it will not be submitted later");
  });

  it("does not persist full playback evidence for ordinary crowd observations", () => {
    expect(observationRoute).not.toContain("playbackEvidence");
    expect(observationRoute).not.toContain("recordCommunityPlaybackEvidence");
  });

  it("changes API courts to hybrid inside the canonical admin transaction", () => {
    expect(adminRoute).not.toContain('.from("courts").update');
    expect(setMigration.indexOf("commit_result := public.community_commit_locked_score")).toBeGreaterThan(-1);
    expect(setMigration.indexOf("set mode = 'hybrid'")).toBeGreaterThan(
      setMigration.indexOf("commit_result := public.community_commit_locked_score")
    );
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
