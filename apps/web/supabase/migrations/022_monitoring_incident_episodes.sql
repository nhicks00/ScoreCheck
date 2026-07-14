-- 022: Store every monitoring outage as its own durable incident episode.
-- The same fingerprint may recur after resolution, but only one active episode
-- for a fingerprint may exist at a time.

alter table public.monitoring_incidents
  drop constraint if exists monitoring_incidents_fingerprint_key;

drop index if exists public.monitoring_incidents_fingerprint_key;

create unique index if not exists monitoring_incidents_active_fingerprint_key
  on public.monitoring_incidents(fingerprint)
  where status <> 'resolved';

create or replace function public.monitoring_incident_episode_contract()
returns integer
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select case
    when exists (
      select 1
      from pg_catalog.pg_indexes
      where schemaname = 'public'
        and tablename = 'monitoring_incidents'
        and indexname = 'monitoring_incidents_active_fingerprint_key'
        and indexdef ilike 'create unique index%'
        and indexdef ilike '%where (status <> ''resolved''%'
    )
    and not exists (
      select 1
      from pg_catalog.pg_constraint
      where conrelid = 'public.monitoring_incidents'::regclass
        and contype = 'u'
        and pg_get_constraintdef(oid) ilike '%fingerprint%'
    ) then 1
    else 0
  end;
$$;

revoke all on function public.monitoring_incident_episode_contract() from public, anon, authenticated;
grant execute on function public.monitoring_incident_episode_contract() to service_role;

comment on function public.monitoring_incident_episode_contract() is
  'Returns 1 only when per-episode monitoring incident uniqueness is installed.';
