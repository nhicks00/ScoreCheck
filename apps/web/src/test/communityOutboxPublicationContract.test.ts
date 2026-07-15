import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/024_community_witness_transactions.sql"),
  "utf8"
);
const scoreStateSource = readFileSync(join(process.cwd(), "src/lib/scoreState.ts"), "utf8");

function functionBody(source: string, name: string, nextName: string) {
  const start = source.indexOf(`create or replace function public.${name}`);
  const end = source.indexOf(`create or replace function public.${nextName}`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Could not isolate ${name}`);
  return source.slice(start, end);
}

describe("atomic canonical outbox publication contract", () => {
  const publisher = functionBody(
    migration,
    "community_publish_score_outbox",
    "community_claim_score_outbox"
  );

  it("locks the outbox, court, and canonical score before the guarded projection write", () => {
    expect(publisher).toMatch(/from public\.canonical_score_outbox[\s\S]*?for update/);
    expect(publisher).toMatch(/from public\.courts[\s\S]*?for update/);
    expect(publisher).toMatch(/from public\.score_states[\s\S]*?for update/);

    const revisionGuard = publisher.indexOf("if score_row.revision <> p_projection_revision");
    const courtUpdate = publisher.indexOf("update public.courts set");
    const overlayUpsert = publisher.indexOf("insert into public.overlay_states");
    const outboxPublish = publisher.lastIndexOf("update public.canonical_score_outbox set");
    expect(revisionGuard).toBeGreaterThan(0);
    expect(courtUpdate).toBeGreaterThan(revisionGuard);
    expect(overlayUpsert).toBeGreaterThan(courtUpdate);
    expect(outboxPublish).toBeGreaterThan(overlayUpsert);
  });

  it("closes transitioned matches as historical before any overlay upsert", () => {
    const historicalGuard = publisher.indexOf(
      "if court_row.current_match_id is distinct from outbox_row.match_id"
    );
    const historicalStatus = publisher.indexOf("'status', 'HISTORICAL'", historicalGuard);
    const overlayUpsert = publisher.indexOf("insert into public.overlay_states");
    expect(historicalGuard).toBeGreaterThan(0);
    expect(historicalStatus).toBeGreaterThan(historicalGuard);
    expect(historicalStatus).toBeLessThan(overlayUpsert);
    expect(publisher).toContain("p_overlay_payload->>'eventId' is distinct from outbox_row.event_id::text");
    expect(publisher).toContain("p_overlay_payload->'match'->>'id' is distinct from outbox_row.match_id::text");
  });

  it("routes application publication through the atomic RPC instead of the old split write", () => {
    const start = scoreStateSource.indexOf("export async function publishCanonicalScoreOutbox");
    const end = scoreStateSource.indexOf("export async function drainCanonicalScoreOutbox", start);
    const applicationPublisher = scoreStateSource.slice(start, end);
    expect(applicationPublisher).toContain("publishCanonicalOutboxProjection");
    expect(applicationPublisher).not.toContain("await projectScoreOverlay(");
  });
});
