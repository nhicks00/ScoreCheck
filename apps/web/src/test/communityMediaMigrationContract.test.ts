import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/028_community_media_sessions.sql"),
  "utf8"
);
const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf8");
const brokerRoute = readFileSync(
  join(process.cwd(), "src/app/api/community/session/media/whep/route.ts"),
  "utf8"
);
const cleanupRoute = readFileSync(
  join(process.cwd(), "src/app/api/community/session/media/whep/[sessionId]/route.ts"),
  "utf8"
);

describe("community media migration contract", () => {
  it("keeps media admission service-only and capacity bounded", () => {
    expect(migration).toContain("create table public.community_media_sessions");
    expect(migration).toContain("community_media_sessions_one_open_assignment_idx");
    expect(migration).toContain("p_max_per_court");
    expect(migration).toContain("p_max_total");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("community-media-capacity:global");
    expect(migration).toContain("media.status in ('ACTIVE', 'CLOSE_REQUESTED', 'CLEANING')");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("revoke all on table public.community_media_sessions from public, anon, authenticated");
  });

  it("binds every reservation to the active assignment, court, and match", () => {
    expect(migration).toContain("assignment.session_token_hash = p_session_token_hash");
    expect(migration).toContain("court_row.current_match_id is distinct from assignment_row.match_id");
    expect(migration).toContain("assignment_row.lease_expires_at <= now()");
    expect(migration).toContain("community media reservation is still opening");
  });

  it("never treats a bearer designated invite as proof of physical courtside trust", () => {
    expect(migration).toContain("community_enforce_remote_designated_grant");
    expect(migration).toContain("new.trust_tier := 'REMOTE'");
    expect(migration).toContain("new.session_token_hash is distinct from old.session_token_hash");
    expect(migration).toContain("and grant_id is not null");
  });

  it("closes playback on revocation, release, and match transitions", () => {
    expect(migration).toContain("community_close_media_on_assignment_change");
    expect(migration).toContain("new.status <> 'ACTIVE'");
    expect(migration).toContain("new.match_id is distinct from old.match_id");
    expect(migration).toContain("media.status = 'CLEANING'");
    expect(migration).toContain("media.cleanup_claim_expires_at <= now()");
  });

  it("retains an admitted upstream resource when setup cleanup must retry", () => {
    expect(migration).toContain("p_upstream_resource_url text default null");
    expect(migration).toContain("upstream setup cleanup required");
    expect(migration).toContain("set status = 'CLOSE_REQUESTED'");
  });

  it("binds playback evidence to the exact accepted action revision", () => {
    expect(migration).toContain("event.revision = p_base_revision + 1");
    expect(migration).not.toContain("observation.base_revision = p_base_revision");
    expect(migration).toContain("uncorrelated_client_diagnostic");
    expect(migration).toContain("community_playback_evidence_immutable_update");
    expect(migration).toContain("community_prune_media_history");
    expect(migration).toContain("community_scorer_command_recorded");
    expect(migration).toContain("action_type not in ('ADD_POINT', 'REMOVE_POINT', 'SET_CURRENT_SET')");
    expect(migration).toContain("if action_type in ('ADD_POINT', 'REMOVE_POINT') then");
  });

  it("fences cleanup completion with a unique claim token", () => {
    expect(migration).toContain("cleanup_claim_token uuid");
    expect(migration).toContain("and cleanup_claim_token = p_cleanup_claim_token");
    expect(migration).toContain("'cleanupClaimToken', claimed.cleanup_claim_token");
  });

  it("removes YouTube from the Community Witness DTO", () => {
    const hardCut = migration.slice(migration.indexOf("create or replace function public.community_match_json"));
    expect(hardCut).not.toContain("youtubeVideoId");
  });

  it("runs cleanup independently and durably retains a failed opened resource", () => {
    expect(worker).toContain("setInterval(() => void maybeRunCommunityMediaCleanup()");
    expect(brokerRoute).toContain("upstreamResource: openedResource");
    expect(cleanupRoute).toContain("community-media-close:");
    expect(cleanupRoute).toContain("community-media-close-ip:");
  });
});
