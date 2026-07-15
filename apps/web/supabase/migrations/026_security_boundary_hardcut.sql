-- Hard cutover: browsers never read or mutate service-owned database rows.
-- Public data is served by allowlisted Next.js DTOs; realtime clients receive
-- only explicit, sanitized broadcasts rather than Postgres row replication.

do $security_boundary$
declare
  protected_table text;
  existing_policy record;
  protected_tables constant text[] := array[
    -- Event, scoring, worker, and operational state.
    'events',
    'courts',
    'bracket_sources',
    'matches',
    'score_states',
    'overlay_states',
    'score_actions',
    'poller_leases',
    'audit_logs',
    'court_match_queue',
    'worker_heartbeats',
    'poller_jobs',
    'poller_errors',
    'program_heartbeats',
    'score_source_heartbeats',

    -- Legacy scorer/community state retained only during this hard cutover.
    'user_profiles',
    'scorer_claims',
    'scorer_sessions',
    'scorer_shadow_states',
    'scorer_session_events',
    'youtube_chat_messages',
    'chat_messages',
    'court_flags',

    -- Monitoring/control-plane state.
    'monitoring_profiles',
    'court_monitoring_expectations',
    'monitoring_incidents',
    'monitoring_incident_events',
    'incident_notifications',
    'monitoring_silences',
    'monitoring_checkpoints',
    'sync_calibrations',
    'event_monitoring_summaries',

    -- Community Witness tables created by the preceding hard-cutover schema.
    'community_admission_counters',
    'community_join_grants',
    'community_assignments',
    'observer_sessions',
    'rally_observations',
    'rally_resolutions',
    'contribution_receipts',
    'canonical_score_events',
    'canonical_score_outbox',
    'match_score_projections',
    'score_disputes',
    'scorer_assignments'
  ];
begin
  foreach protected_table in array protected_tables loop
    if to_regclass(format('public.%I', protected_table)) is null then
      continue;
    end if;

    for existing_policy in
      select policyname
      from pg_policies
      where schemaname = 'public'
        and tablename = protected_table
    loop
      execute format(
        'drop policy %I on public.%I',
        existing_policy.policyname,
        protected_table
      );
    end loop;

    execute format('alter table public.%I enable row level security', protected_table);
    execute format('alter table public.%I force row level security', protected_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', protected_table);
    execute format('grant all on table public.%I to service_role', protected_table);
  end loop;
end
$security_boundary$;

-- SECURITY DEFINER functions bypass table RLS. PostgreSQL grants EXECUTE on
-- new functions to PUBLIC by default, so the routine boundary must be closed
-- independently of the table boundary.
do $routine_boundary$
declare
  app_function record;
begin
  for app_function in
    select
      n.nspname as schema_name,
      p.proname as function_name,
      pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
  loop
    execute format(
      'revoke all on function %I.%I(%s) from public, anon, authenticated',
      app_function.schema_name,
      app_function.function_name,
      app_function.identity_arguments
    );
    execute format(
      'grant execute on function %I.%I(%s) to service_role',
      app_function.schema_name,
      app_function.function_name,
      app_function.identity_arguments
    );
  end loop;
end
$routine_boundary$;

-- Prevent later tables created by this migration role from silently inheriting
-- browser privileges. RLS must still be explicitly enabled by their migration.
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public grant execute on functions to service_role;

-- Raw Postgres changes expose complete rows and automatically expose future
-- columns. Remove every public table from the publication. The overlay keeps
-- using realtime.send(...) broadcasts; chat already has an HTTP polling path.
do $realtime_boundary$
declare
  published_table record;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;

  for published_table in
    select schemaname, tablename
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
  loop
    execute format(
      'alter publication supabase_realtime drop table %I.%I',
      published_table.schemaname,
      published_table.tablename
    );
  end loop;
end
$realtime_boundary$;

comment on schema public is
  'Service-owned ScoreCheck data. Browser roles have no direct table access; public reads use allowlisted server DTOs.';
