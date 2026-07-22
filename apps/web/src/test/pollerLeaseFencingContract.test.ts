import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const migration = readFileSync(path.join(root, "supabase/migrations/030_poller_lease_fencing.sql"), "utf8");
const poller = readFileSync(path.join(root, "src/lib/poller.ts"), "utf8");
const witness = readFileSync(path.join(root, "src/lib/communityWitness.ts"), "utf8");

describe("poller lease fencing contract", () => {
  it("increments a durable lease generation on every takeover", () => {
    expect(migration).toContain("add column if not exists generation bigint not null default 1");
    expect(migration).toContain("public.poller_leases.generation + 1");
    expect(migration).toContain("returns jsonb");
    expect(poller).toContain("result.generation");
  });

  it("holds the lease row while the provider commit runs and rejects stale generations", () => {
    expect(migration).toContain("for share");
    expect(migration).toContain("lease_row.generation <> p_lease_generation");
    expect(migration).toContain("lease_row.expires_at <= clock_timestamp()");
    expect(migration).toContain("using errcode = '40001'");
    expect(witness).toContain('rpc("community_commit_provider_score_fenced"');
    expect(witness).toContain("Provider score commits require a poller lease fencing token");
  });

  it("keeps concurrent court polls isolated through async-local lease context", () => {
    expect(poller).toContain("new AsyncLocalStorage<PollerLease>()");
    expect(poller).toContain("pollerLeaseContext.run(");
    expect(poller).toContain("pollerLeaseContext.getStore()");
  });
});
