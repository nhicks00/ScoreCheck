#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_ROOT = dirname(SCRIPT_PATH);
const REPOSITORY_ROOT = resolve(SCRIPT_ROOT, "../..");
const APPLY_ACKNOWLEDGEMENT = "APPLY_SCORING_SCHEMA_023_030";

export const SCORING_MIGRATIONS = Object.freeze([
  ["023", "community_witness_schema"],
  ["024", "community_witness_transactions"],
  ["026", "security_boundary_hardcut"],
  ["027", "canonical_current_set_command"],
  ["028", "community_media_sessions"],
  ["030", "poller_lease_fencing"]
]);

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  const result = await writeScoringSchemaCutover(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function writeScoringSchemaCutover({ mode, output, acknowledgement }) {
  if (mode === "apply" && acknowledgement !== APPLY_ACKNOWLEDGEMENT) {
    throw new Error(`apply mode requires --acknowledge ${APPLY_ACKNOWLEDGEMENT}`);
  }
  const target = normalizedAbsolute(output, "--output");
  const parent = await stat(dirname(target));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
    throw new Error("cutover SQL parent must be mode 0700 or stricter");
  }
  try {
    await stat(target);
    throw new Error("cutover SQL output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const sql = await buildScoringSchemaCutover({ mode });
  await writeFile(target, sql, { flag: "wx", mode: 0o600 });
  await chmod(target, 0o600);
  return {
    status: "PASS",
    mode,
    output: target,
    bytes: Buffer.byteLength(sql),
    sha256: createHash("sha256").update(sql).digest("hex"),
    migrations: SCORING_MIGRATIONS.map(([version]) => version)
  };
}

export async function buildScoringSchemaCutover({ mode, repositoryRoot = REPOSITORY_ROOT }) {
  if (!new Set(["rehearsal", "apply"]).has(mode)) throw new Error("mode must be rehearsal or apply");
  const migrations = [];
  for (const [version, name] of SCORING_MIGRATIONS) {
    const path = resolve(repositoryRoot, `apps/web/supabase/migrations/${version}_${name}.sql`);
    const sql = await readFile(path, "utf8");
    if (/^\s*(begin|commit|rollback)\s*;/im.test(sql)) throw new Error(`migration ${version} contains transaction control`);
    const delimiter = `$scorecheck_migration_${version}$`;
    if (sql.includes(delimiter)) throw new Error(`migration ${version} contains its ledger delimiter`);
    migrations.push({ version, name, sql, delimiter });
  }

  const migrationSql = migrations.map(({ version, name, sql, delimiter }) => [
    `-- BEGIN ${version}_${name}.sql`,
    sql.trimEnd(),
    `-- END ${version}_${name}.sql`,
    `insert into supabase_migrations.schema_migrations (version, name, statements)`,
    `values ('${version}', '${name}', array[${delimiter}${sql}${delimiter}]);`
  ].join("\n")).join("\n\n");

  const finish = mode === "apply" ? "commit;" : "rollback;";
  const postflight = mode === "apply" ? appliedPostflightSql() : rehearsalPostflightSql();
  return `${header(mode)}
begin;
set local lock_timeout = '5s';
set local statement_timeout = '10min';
select pg_advisory_xact_lock(hashtext('scorecheck-scoring-schema-023-030'));

${preflightSql()}

${migrationSql}

${contractVerificationSql()}

savepoint scorecheck_fencing_fixture;
${fencingFixtureSql()}
rollback to savepoint scorecheck_fencing_fixture;
release savepoint scorecheck_fencing_fixture;

${finish}

${postflight}
`;
}

function header(mode) {
  return `-- ScoreCheck scoring schema ${mode} generated from the checked-in migration sources.
-- This file contains no credentials and does not connect to Supabase by itself.
-- Expected production history: 022 and 029 present; 023,024,026,027,028,030 absent.
-- The worker must be stopped and all poller leases expired before submission.
-- ${mode === "rehearsal" ? "Every schema, ledger, and fixture change is rolled back." : "This commits the hard cutover only after in-transaction verification passes."}`;
}

function preflightSql() {
  return `do $scorecheck_preflight$
declare
  target_versions text[] := array['023','024','026','027','028','030'];
begin
  if not exists (
    select 1 from supabase_migrations.schema_migrations
    where version = '022' and name = 'monitoring_incident_episodes'
  ) then
    raise exception 'scoring cutover refused: exact migration 022 is missing';
  end if;
  if not exists (
    select 1 from supabase_migrations.schema_migrations
    where version = '029' and name = 'monitoring_pushover_only'
  ) then
    raise exception 'scoring cutover refused: exact migration 029 is missing';
  end if;
  if exists (
    select 1 from supabase_migrations.schema_migrations where version = any(target_versions)
  ) then
    raise exception 'scoring cutover refused: one or more target migrations are already recorded';
  end if;
  if to_regclass('public.community_assignments') is not null
    or to_regprocedure('public.community_commit_provider_score_fenced(uuid,uuid,uuid,text,text,text,bigint,bigint,jsonb,text,bigint,text,text,jsonb,jsonb)') is not null
    or exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'poller_leases' and column_name = 'generation'
    ) then
    raise exception 'scoring cutover refused: schema objects exist without their migration ledger';
  end if;
  if exists (
    select 1 from public.poller_leases where expires_at > clock_timestamp()
  ) then
    raise exception 'scoring cutover refused: a provider poller lease is still active';
  end if;
end;
$scorecheck_preflight$;`;
}

function contractVerificationSql() {
  return `do $scorecheck_contract$
declare
  expected_versions text[] := array['023','024','026','027','028','030'];
begin
  if (
    select array_agg(version order by version)
    from supabase_migrations.schema_migrations
    where version = any(expected_versions)
  ) is distinct from expected_versions then
    raise exception 'scoring cutover contract failed: migration ledger is incomplete';
  end if;
  if to_regclass('public.community_assignments') is null
    or to_regclass('public.canonical_score_outbox') is null
    or to_regclass('public.community_media_sessions') is null
    or to_regprocedure('public.community_commit_trusted_score(uuid,uuid,uuid,text,text,text,text,bigint,bigint,jsonb,text,text,jsonb,jsonb)') is null
    or to_regprocedure('public.community_commit_provider_score_fenced(uuid,uuid,uuid,text,text,text,bigint,bigint,jsonb,text,bigint,text,text,jsonb,jsonb)') is null
    or to_regprocedure('public.community_select_current_set(jsonb,jsonb,jsonb)') is null then
    raise exception 'scoring cutover contract failed: required table or RPC is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'poller_leases'
      and column_name = 'generation' and data_type = 'bigint'
  ) then
    raise exception 'scoring cutover contract failed: poller lease generation is missing';
  end if;
  if has_table_privilege('anon', 'public.community_assignments', 'SELECT')
    or has_table_privilege('authenticated', 'public.community_assignments', 'SELECT')
    or not has_function_privilege(
      'service_role',
      'public.community_commit_provider_score_fenced(uuid,uuid,uuid,text,text,text,bigint,bigint,jsonb,text,bigint,text,text,jsonb,jsonb)',
      'EXECUTE'
    ) then
    raise exception 'scoring cutover contract failed: role boundary is invalid';
  end if;
end;
$scorecheck_contract$;`;
}

function fencingFixtureSql() {
  return `do $scorecheck_fencing_fixture$
declare
  test_event_id uuid := gen_random_uuid();
  test_match_id uuid := gen_random_uuid();
  test_court_id uuid := gen_random_uuid();
  first_lease jsonb;
  second_lease jsonb;
  score_row public.score_states%rowtype;
  commit_result jsonb;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (test_event_id, 'Scoring cutover fixture', 'active', 'cutover-' || test_event_id::text, false);
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values (
    test_match_id, test_event_id, 'cutover-match', 'manual', 'active', 'Alpha', 'Bravo',
    '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    test_court_id, test_event_id, 1, 'Scoring cutover fixture', test_match_id,
    'manual', 'live', false, true, 'cutover_preview', 'cutover_program'
  );

  score_row := public.community_ensure_score_projection(
    test_event_id, test_court_id, test_match_id, 'PROVIDER_PRIMARY'
  );
  first_lease := public.try_acquire_poller_lease(
    test_event_id, test_court_id, 'cutover-worker-a', 60000
  );
  if (first_lease->>'acquired')::boolean is not true
    or (first_lease->>'generation')::bigint <> 1 then
    raise exception 'scoring cutover fixture failed: first lease was not generation one';
  end if;

  commit_result := public.community_commit_provider_score_fenced(
    test_event_id, test_court_id, test_match_id, gen_random_uuid()::text,
    'Scoring cutover worker A', 'PROVIDER_PRIMARY', score_row.revision,
    score_row.authority_epoch, public.community_score_input_json(score_row),
    'cutover-worker-a', 1, 'CORRECT_SCORE', null,
    '{"source":"api","sourceAvailable":true,"sourcePriority":"primary","sourcePendingScores":[],"stale":false,"message":null}'::jsonb,
    '{"fixture":true}'::jsonb
  );
  if coalesce((commit_result->>'ok')::boolean, false) is not true then
    raise exception 'scoring cutover fixture failed: current lease did not commit';
  end if;

  update public.poller_leases set expires_at = clock_timestamp() - interval '1 second'
  where court_id = test_court_id;
  second_lease := public.try_acquire_poller_lease(
    test_event_id, test_court_id, 'cutover-worker-b', 60000
  );
  if (second_lease->>'acquired')::boolean is not true
    or (second_lease->>'generation')::bigint <> 2 then
    raise exception 'scoring cutover fixture failed: ownership change did not increment generation';
  end if;

  select * into score_row from public.score_states where match_id = test_match_id;
  begin
    perform public.community_commit_provider_score_fenced(
      test_event_id, test_court_id, test_match_id, gen_random_uuid()::text,
      'Stale scoring cutover worker', 'PROVIDER_PRIMARY', score_row.revision,
      score_row.authority_epoch, public.community_score_input_json(score_row),
      'cutover-worker-a', 1, 'CORRECT_SCORE', null,
      '{"source":"api","sourceAvailable":true,"sourcePriority":"primary","sourcePendingScores":[],"stale":false,"message":null}'::jsonb,
      '{"fixture":true}'::jsonb
    );
    raise exception 'scoring cutover fixture failed: stale lease committed';
  exception when sqlstate '40001' then
    null;
  end;

  commit_result := public.community_commit_provider_score_fenced(
    test_event_id, test_court_id, test_match_id, gen_random_uuid()::text,
    'Scoring cutover worker B', 'PROVIDER_PRIMARY', score_row.revision,
    score_row.authority_epoch, public.community_score_input_json(score_row),
    'cutover-worker-b', 2, 'CORRECT_SCORE', null,
    '{"source":"api","sourceAvailable":true,"sourcePriority":"primary","sourcePendingScores":[],"stale":false,"message":null}'::jsonb,
    '{"fixture":true}'::jsonb
  );
  if coalesce((commit_result->>'ok')::boolean, false) is not true then
    raise exception 'scoring cutover fixture failed: replacement lease did not commit';
  end if;
end;
$scorecheck_fencing_fixture$;`;
}

function appliedPostflightSql() {
  return `do $scorecheck_applied_postflight$
begin
  if (
    select array_agg(version order by version)
    from supabase_migrations.schema_migrations
    where version = any(array['023','024','026','027','028','030'])
  ) is distinct from array['023','024','026','027','028','030'] then
    raise exception 'scoring cutover postflight failed after commit';
  end if;
end;
$scorecheck_applied_postflight$;
select jsonb_build_object(
  'status', 'PASS',
  'mode', 'apply',
  'migrations', array['023','024','026','027','028','030']
) as scorecheck_scoring_schema_cutover;`;
}

function rehearsalPostflightSql() {
  return `do $scorecheck_rehearsal_postflight$
begin
  if exists (
    select 1 from supabase_migrations.schema_migrations
    where version = any(array['023','024','026','027','028','030'])
  ) or to_regclass('public.community_assignments') is not null then
    raise exception 'scoring cutover rehearsal failed to roll back';
  end if;
end;
$scorecheck_rehearsal_postflight$;
select jsonb_build_object(
  'status', 'PASS',
  'mode', 'rehearsal',
  'rolledBack', true,
  'migrations', array['023','024','026','027','028','030']
) as scorecheck_scoring_schema_cutover;`;
}

function parseArgs(argv) {
  if ([undefined, "help", "-h", "--help"].includes(argv[0])) return null;
  if (!new Set(["rehearsal", "apply"]).has(argv[0])) throw new Error("first argument must be rehearsal or apply");
  const options = { mode: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    if (flag === "--output") options.output = value;
    else if (flag === "--acknowledge") options.acknowledgement = value;
    else throw new Error(`${flag} is unknown`);
  }
  if (!options.output) throw new Error("--output is required");
  options.output = normalizedAbsolute(options.output, "--output");
  return options;
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  return value;
}

function usage() {
  process.stdout.write(`usage:\n  scoring-schema-cutover.mjs rehearsal --output </protected/rehearsal.sql>\n  scoring-schema-cutover.mjs apply --output </protected/apply.sql> --acknowledge ${APPLY_ACKNOWLEDGEMENT}\n`);
}
