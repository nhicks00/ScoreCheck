-- Keep high-frequency poll freshness out of Realtime-retained change data.
-- The score source is still polled at live-score cadence, while this table is
-- updated at a bounded cadence and semantic score changes remain immediate.

create table if not exists public.score_source_heartbeats (
  court_id uuid primary key references public.courts(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  source_available boolean not null default false,
  last_poll_at timestamptz,
  last_error_at timestamptz,
  error_message text,
  updated_at timestamptz not null default now()
);

create index if not exists score_source_heartbeats_event_idx
  on public.score_source_heartbeats(event_id, court_id);

alter table public.score_source_heartbeats enable row level security;
revoke all on table public.score_source_heartbeats from anon, authenticated;
grant all on table public.score_source_heartbeats to service_role;

comment on table public.score_source_heartbeats is
  'Bounded-cadence poll freshness for server-side health checks; intentionally excluded from Supabase Realtime.';

-- Preserve the last successful poll across failure observations. A generic
-- upsert cannot safely distinguish an omitted last_poll_at from an explicit
-- reset when a worker's in-memory cache is cold.
create or replace function public.record_score_source_heartbeat(
  p_court_id uuid,
  p_event_id uuid,
  p_match_id uuid,
  p_source_available boolean,
  p_successful boolean,
  p_observed_at timestamptz,
  p_error_message text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_observed_at is null then
    raise exception 'source heartbeat observation time is required';
  end if;

  insert into public.score_source_heartbeats (
    court_id,
    event_id,
    match_id,
    source_available,
    last_poll_at,
    last_error_at,
    error_message,
    updated_at
  ) values (
    p_court_id,
    p_event_id,
    p_match_id,
    coalesce(p_source_available, false),
    case when p_successful then p_observed_at else null end,
    case when p_successful then null else p_observed_at end,
    case when p_successful then null else left(coalesce(p_error_message, ''), 500) end,
    p_observed_at
  )
  on conflict (court_id) do update set
    event_id = excluded.event_id,
    match_id = excluded.match_id,
    source_available = excluded.source_available,
    last_poll_at = case
      when p_successful then p_observed_at
      else public.score_source_heartbeats.last_poll_at
    end,
    last_error_at = case when p_successful then null else p_observed_at end,
    error_message = case when p_successful then null else left(coalesce(p_error_message, ''), 500) end,
    updated_at = p_observed_at
  where public.score_source_heartbeats.updated_at <= excluded.updated_at;
end;
$$;

revoke all on function public.record_score_source_heartbeat(uuid, uuid, uuid, boolean, boolean, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.record_score_source_heartbeat(uuid, uuid, uuid, boolean, boolean, timestamptz, text)
  to service_role;

comment on function public.record_score_source_heartbeat(uuid, uuid, uuid, boolean, boolean, timestamptz, text) is
  'Records bounded source freshness without allowing an error observation to erase the last successful poll.';

-- No browser in the current architecture subscribes to score_states. Overlay
-- delivery uses the semantic overlay_state broadcast trigger plus HTTP repair
-- polling. Keeping score_states in the publication retained every timestamp-
-- only poll update in realtime.messages.
do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'score_states'
  ) then
    alter publication supabase_realtime drop table public.score_states;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'score_source_heartbeats'
  ) then
    alter publication supabase_realtime drop table public.score_source_heartbeats;
  end if;
end $$;

-- Lease acquisition must be atomic. The previous SELECT-then-UPSERT sequence
-- had a race between concurrent workers and performed two database calls for
-- every court on every 1.8-second poll.
create or replace function public.try_acquire_poller_lease(
  p_event_id uuid,
  p_court_id uuid,
  p_owner text,
  p_lease_ms integer
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  acquired boolean := false;
  lease_now timestamptz := clock_timestamp();
begin
  if p_owner is null or btrim(p_owner) = '' then
    raise exception 'poller lease owner is required';
  end if;
  if p_lease_ms < 1000 or p_lease_ms > 300000 then
    raise exception 'poller lease duration is outside the allowed range';
  end if;

  insert into public.poller_leases (
    event_id,
    court_id,
    owner,
    expires_at,
    last_heartbeat_at
  ) values (
    p_event_id,
    p_court_id,
    p_owner,
    lease_now + make_interval(secs => p_lease_ms::double precision / 1000.0),
    lease_now
  )
  on conflict (court_id) do update set
    event_id = excluded.event_id,
    owner = excluded.owner,
    expires_at = excluded.expires_at,
    last_heartbeat_at = excluded.last_heartbeat_at
  where public.poller_leases.owner = excluded.owner
     or public.poller_leases.expires_at <= lease_now
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

revoke all on function public.try_acquire_poller_lease(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.try_acquire_poller_lease(uuid, uuid, text, integer) to service_role;

comment on function public.try_acquire_poller_lease(uuid, uuid, text, integer) is
  'Atomically acquires or renews one court poller lease for the current owner.';
