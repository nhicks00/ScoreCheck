import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  publicCourtCoverage,
  toPublicCourtCardDto,
  toPublicCourtDetailDto,
  toPublicEventSummaryDto,
  toPublicScorerStatusDto
} from "../lib/publicDtos";

const migrationPath = join(process.cwd(), "supabase/migrations/026_security_boundary_hardcut.sql");
const publicRoutePaths = [
  "src/app/api/public/current-event/route.ts",
  "src/app/api/public/events/[eventSlug]/courts/route.ts",
  "src/app/api/public/courts/[courtParam]/route.ts"
];

describe("public DTO security boundary", () => {
  const privateEvent = {
    id: "event-1",
    name: "Summer Open",
    slug: "summer-open",
    settings: { operatorPin: "secret" },
    created_at: "private-timestamp"
  };
  const privateCourt = {
    id: "court-1",
    court_number: 2,
    display_name: "Center Court",
    scoring_open: true,
    last_update_at: "2026-07-14T12:00:00.000Z",
    youtube_video_id: "public-video-id",
    scorer_token_hash: "must-not-leak",
    youtube_stream_key: "must-not-leak",
    ivs_channel_arn: "must-not-leak",
    ivs_playback_url: "must-not-leak",
    preview_stream_path: "must-not-leak",
    program_stream_path: "must-not-leak"
  };
  const privateMatch = {
    id: "match-1",
    match_number: "12",
    round_name: "Final",
    team_a: "Alpha",
    team_b: "Bravo",
    status: "live",
    api_url: "must-not-leak",
    source_payload: { secret: true }
  };
  const privateScore = {
    match_id: "match-1",
    team_a_score: 12,
    team_b_score: 10,
    team_a_sets: 1,
    team_b_sets: 0,
    current_set: 2,
    set_scores: [{
      setNumber: 1,
      teamAScore: 21,
      teamBScore: 18,
      isComplete: true,
      privateNote: "must-not-leak"
    }],
    status: "In Progress",
    source: "override",
    message: "must-not-leak",
    last_score_change_at: "2026-07-14T12:00:00.000Z",
    updated_at: "2026-07-14T12:00:01.000Z"
  };
  const privateStatus = {
    needsScorer: false,
    backupRequested: true,
    hasActive: true,
    backupCount: 3,
    activeName: "  Courtside Sam  ",
    session_token_hash: "must-not-leak"
  };
  const publicStatus = toPublicScorerStatusDto(privateStatus);

  it("copies only allowlisted event fields", () => {
    expect(toPublicEventSummaryDto(privateEvent)).toEqual({
      name: "Summer Open",
      slug: "summer-open"
    });
  });

  it("copies only allowlisted court-card fields, including nested set scores", () => {
    const dto = toPublicCourtCardDto({
      court: privateCourt,
      match: privateMatch,
      score: privateScore,
      scorerStatus: publicStatus
    });

    expect(dto).toEqual({
      id: "court-1",
      courtNumber: 2,
      displayName: "Center Court",
      scoringOpen: true,
      lastUpdateAt: "2026-07-14T12:00:00.000Z",
      youtubeVideoId: "public-video-id",
      backupRequested: true,
      scorerStatus: {
        needsScorer: false,
        hasActive: true,
        backups: 3,
        activeName: "Courtside Sam"
      },
      match: {
        id: "match-1",
        matchNumber: "12",
        roundName: "Final",
        teamA: "Alpha",
        teamB: "Bravo"
      },
      score: {
        teamAScore: 12,
        teamBScore: 10,
        teamASets: 1,
        teamBSets: 0,
        currentSet: 2,
        setScores: [{ setNumber: 1, teamAScore: 21, teamBScore: 18, isComplete: true }],
        status: "In Progress",
        lastScoreChangeAt: "2026-07-14T12:00:00.000Z",
        updatedAt: "2026-07-14T12:00:01.000Z"
      }
    });
    expect(JSON.stringify(dto)).not.toMatch(/token|stream_key|channel_arn|source_payload|privateNote/i);
  });

  it("keeps the single-court identifiers while excluding private row columns", () => {
    const dto = toPublicCourtDetailDto({
      event: privateEvent,
      court: privateCourt,
      match: privateMatch,
      score: privateScore,
      scorerStatus: publicStatus
    });

    expect(dto.event).toEqual({ id: "event-1", name: "Summer Open", slug: "summer-open" });
    expect(dto.court).toEqual({
      id: "court-1",
      court_number: 2,
      display_name: "Center Court",
      scoring_open: true
    });
    expect(JSON.stringify(dto)).not.toMatch(/token|stream|api_url|source_payload|ip_hash|user_agent/i);
  });

  it("does not let malformed values expand the public response", () => {
    const status = toPublicScorerStatusDto({
      needsScorer: "true",
      backupRequested: 1,
      hasActive: {},
      backupCount: -50,
      activeName: { nested: "private" }
    });
    expect(status).toEqual({
      needsScorer: false,
      backupRequested: false,
      hasActive: false,
      backupCount: 0,
      activeName: null
    });
  });

  it.each(["ADMIN_LOCKED", "PROVIDER_PRIMARY", "DESIGNATED_PRIMARY", "VERIFIED_CONSENSUS"])(
    "treats %s authority as active coverage without requiring a designated scorer",
    (authorityMode) => {
      expect(publicCourtCoverage({ scoringOpen: true, hasMatch: true, authorityMode })).toEqual({
        needsScorer: false,
        hasActive: true
      });
    }
  );

  it("only asks for a scorer when an open court with a match is paused or missing authority", () => {
    expect(publicCourtCoverage({ scoringOpen: true, hasMatch: true, authorityMode: "PAUSED_DISPUTE" })).toEqual({
      needsScorer: true,
      hasActive: false
    });
    expect(publicCourtCoverage({ scoringOpen: true, hasMatch: true, authorityMode: null })).toEqual({
      needsScorer: true,
      hasActive: false
    });
    expect(publicCourtCoverage({ scoringOpen: false, hasMatch: true, authorityMode: "PAUSED_DISPUTE" })).toEqual({
      needsScorer: false,
      hasActive: false
    });
    expect(publicCourtCoverage({ scoringOpen: true, hasMatch: false, authorityMode: "PROVIDER_PRIMARY" })).toEqual({
      needsScorer: false,
      hasActive: false
    });
  });
});

describe("database security hard cutover", () => {
  const migration = readFileSync(migrationPath, "utf8");

  it("protects every service table created by preceding migrations", () => {
    const migrationsDirectory = join(process.cwd(), "supabase/migrations");
    const createdTables = readdirSync(migrationsDirectory)
      .filter((name) => /^\d+_.+\.sql$/.test(name) && name < "026_security_boundary_hardcut.sql")
      .flatMap((name) => {
        const sql = readFileSync(join(migrationsDirectory, name), "utf8");
        return [...sql.matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.([a-z0-9_]+)/gi)]
          .map((match) => match[1]);
      });

    expect(createdTables.length).toBeGreaterThan(0);
    for (const table of createdTables) expect(migration).toContain(`'${table}'`);
  });

  it.each([
    "score_states",
    "overlay_states",
    "score_actions",
    "scorer_claims",
    "scorer_sessions",
    "scorer_shadow_states",
    "scorer_session_events",
    "court_flags",
    "community_join_grants",
    "community_assignments",
    "observer_sessions",
    "rally_observations",
    "rally_resolutions",
    "contribution_receipts",
    "canonical_score_events",
    "canonical_score_outbox",
    "match_score_projections",
    "score_disputes",
    "scorer_assignments"
  ])("protects the %s table", (table) => {
    expect(migration).toContain(`'${table}'`);
  });

  it("enables forced RLS, revokes browser roles, and preserves service role access", () => {
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("drop policy %I on public.%I");
    expect(migration).toContain("revoke all on table public.%I from public, anon, authenticated");
    expect(migration).toContain("grant all on table public.%I to service_role");
    expect(migration).not.toMatch(/create\s+policy/i);
  });

  it("closes SECURITY DEFINER and other public functions to browser roles", () => {
    expect(migration).toContain("from pg_proc p");
    expect(migration).toContain("pg_get_function_identity_arguments");
    expect(migration).toContain("revoke all on function %I.%I(%s) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function %I.%I(%s) to service_role");
    expect(migration).toContain("revoke execute on functions from public, anon, authenticated");
  });

  it("removes raw public-table replication from Supabase Realtime", () => {
    expect(migration).toContain("from pg_publication_tables");
    expect(migration).toContain("alter publication supabase_realtime drop table");
    expect(migration).toContain("schemaname = 'public'");
  });
});

describe("public route source contracts", () => {
  it.each(publicRoutePaths)("uses an explicit DTO and no wildcard relation query: %s", (routePath) => {
    const source = readFileSync(join(process.cwd(), routePath), "utf8");
    expect(source).toMatch(/toPublic[A-Za-z]+Dto/);
    expect(source).not.toMatch(/\.select\(\s*["'`]\*/);
    expect(source).not.toMatch(/score_states\(\*\)|matches:[^(]+\(\*\)/);
  });

  it("rejects a UUID court resolved outside the requested event", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/api/public/courts/[courtParam]/route.ts"),
      "utf8"
    );
    expect(source).toContain("data.court.event_id !== data.event.id");
  });
});
