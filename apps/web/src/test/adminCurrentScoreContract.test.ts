import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("admin current-score payload contract", () => {
  it("loads only current-match score rows on every dashboard server page", () => {
    for (const path of [
      "src/app/admin/events/[eventId]/page.tsx",
      "src/app/admin/events/[eventId]/fan-scoring/page.tsx",
      "src/app/admin/avp-denver/page.tsx"
    ]) {
      const page = source(path);
      expect(page).toContain("loadAdminCourtsWithCurrentScores");
      expect(page).not.toContain("score_states(*)");
    }
    const loader = source("src/lib/adminCourtData.ts");
    expect(loader).toContain('.in("match_id", matchIds)');
    expect(loader).toContain("score_states: court.current_match_id ?");
  });

  it("uses the bounded assignment summary and truthful total counts", () => {
    for (const path of [
      "src/app/admin/events/[eventId]/fan-scoring/page.tsx",
      "src/app/admin/avp-denver/page.tsx"
    ]) {
      const page = source(path);
      expect(page).toContain("getCommunityAdminAssignmentSummary");
      expect(page).not.toContain('from("community_assignments")');
    }
    const dashboard = source("src/components/fan-scoring/FanScoringDashboard.tsx");
    expect(dashboard).toContain("Observers shown {assignmentCounts?.returnedObserverCount ?? 0} of {assignmentCounts?.activeObserverCount ?? 0}");
    expect(dashboard).toContain("counts.activeVerifiedWitnessCount");
    expect(dashboard).toContain("counts.activeDesignatedCount");
  });
});
