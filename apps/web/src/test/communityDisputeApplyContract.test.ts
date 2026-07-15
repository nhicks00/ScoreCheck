import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function sqlFunction(sql: string, name: string) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  const end = sql.indexOf("\n$$;", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + 4);
}

describe("community dispute proposal application contract", () => {
  it("routes apply-proposal through one backend reducer and never reduces score in TypeScript", () => {
    const route = source("src/app/api/admin/fan-scoring/disputes/[disputeId]/route.ts");

    expect(route).toContain("actionId: z.string().uuid()");
    expect(route).toContain("await applyCommunityDisputeProposal({");
    expect(route).toContain("actionId: parsed.data.actionId");
    expect(route).toContain("canonical_event_id,proposal_eligible,opened_at");
    expect(route).toContain("classifyCommunityDispute(linkedCommandType, dispute.proposal_eligible)");
    expect(route).toContain("await publishCanonicalScoreOutbox({ outboxId: result.outboxId })");
    expect(route).toContain('projectionStatus: "NOT_REQUIRED"');
    expect(route).toContain("reviewBoundaryCommitted: true");
    expect(route).not.toMatch(/\b(scorePoint|removePoint|normalizeScoreState|formatFromUnknown|persistScoreAndOverlay)\b/);
  });

  it("passes the stable client action ID through the RPC wrapper", () => {
    const witness = source("src/lib/communityWitness.ts");
    const start = witness.indexOf("export function applyCommunityDisputeProposal");
    const end = witness.indexOf("\n}\n", start) + 3;
    const wrapper = witness.slice(start, end);

    expect(wrapper).toContain('rpc("community_apply_dispute_proposal"');
    expect(wrapper).toContain("p_action_id: z.string().uuid().parse(input.actionId)");
    expect(wrapper).not.toContain("crypto.randomUUID()");
  });

  it("locks scope, reduces, commits, and resolves inside one SQL transaction", () => {
    const migration = source("supabase/migrations/024_community_witness_transactions.sql");
    const fn = sqlFunction(migration, "community_apply_dispute_proposal");
    const courtLock = fn.indexOf("from public.courts where id = dispute_row.court_id for update");
    const scoreLock = fn.indexOf("from public.score_states where match_id = dispute_row.match_id for update");
    const disputeLock = fn.indexOf("from public.score_disputes where id = p_dispute_id for update");
    const reduce = fn.indexOf("public.community_reduce_score_action(");
    const commit = fn.indexOf("public.community_commit_locked_score(");
    const resolve = fn.indexOf("public.community_resolve_dispute(");

    expect(fn).toContain("p_action_id uuid");
    expect(fn).toContain("requested_command_id text := p_action_id::text");
    expect(fn).toContain("dispute_row.proposal_eligible is not true");
    expect(courtLock).toBeGreaterThan(0);
    expect(scoreLock).toBeGreaterThan(courtLock);
    expect(disputeLock).toBeGreaterThan(scoreLock);
    expect(reduce).toBeGreaterThan(disputeLock);
    expect(commit).toBeGreaterThan(reduce);
    expect(resolve).toBeGreaterThan(commit);
    expect(fn.match(/public\.community_reduce_score_action\(/g)).toHaveLength(1);
    expect(fn.match(/public\.community_commit_locked_score\(/g)).toHaveLength(1);
  });

  it("exposes every vote while withholding one-click apply from ties and post-canonical dissent", () => {
    const migration = source("supabase/migrations/024_community_witness_transactions.sql");
    const witness = source("src/lib/communityWitness.ts");
    const dashboard = source("src/components/fan-scoring/FanScoringDashboard.tsx");

    expect(migration).toContain("leading_count * 2 > eligible_count, vote_breakdown");
    expect(migration).toContain("'voteBreakdown', dispute.vote_breakdown");
    expect(migration).toContain("'proposalEligible', dispute.proposal_eligible");
    expect(witness).toContain("voteBreakdown: z.array(z.object({");
    expect(witness).toContain("proposalEligible: z.boolean()");
    expect(witness).toContain("totalOpenCount: z.number().int().min(0)");
    expect(witness).toContain("outboxId: z.string().uuid().nullable().optional()");
    expect(dashboard).toContain("const voteBreakdown = formatVoteBreakdown(dispute)");
    expect(dashboard).toMatch(/proposalHasNoMajority\s*\? "No strict majority"/);
    expect(dashboard).toContain("Open score editor");
    expect(dashboard).toContain("Resolve after correction");
    expect(dashboard).toContain("Keep current score");
    expect(dashboard).toContain("below the automatic consensus threshold");
    expect(dashboard).not.toContain("without quorum");
    expect(dashboard).toContain('label: "Verified coverage"');
    expect(dashboard).not.toContain('label: "Consensus covered"');
  });
});
