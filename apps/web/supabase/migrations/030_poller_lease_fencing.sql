-- 030: Fence provider score commits with the exact generation of the court
-- poller lease. A stale process may retain a local lease cache, but it cannot
-- commit after another worker acquires the row.

alter table public.poller_leases
  add column if not exists generation bigint not null default 1
  check (generation > 0);

drop function if exists public.try_acquire_poller_lease(uuid, uuid, text, integer);

create function public.try_acquire_poller_lease(
  p_event_id uuid,
  p_court_id uuid,
  p_owner text,
  p_lease_ms integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  lease_row public.poller_leases%rowtype;
  lease_now timestamptz := clock_timestamp();
begin
  if p_owner is null or btrim(p_owner) = '' or length(p_owner) > 200 then
    raise exception 'poller lease owner is invalid' using errcode = '22023';
  end if;
  if p_lease_ms < 1000 or p_lease_ms > 300000 then
    raise exception 'poller lease duration is outside the allowed range' using errcode = '22023';
  end if;

  insert into public.poller_leases (
    event_id, court_id, owner, generation, expires_at, last_heartbeat_at
  ) values (
    p_event_id, p_court_id, p_owner, 1,
    lease_now + make_interval(secs => p_lease_ms::double precision / 1000.0),
    lease_now
  )
  on conflict (court_id) do update set
    event_id = excluded.event_id,
    owner = excluded.owner,
    generation = case
      when public.poller_leases.owner = excluded.owner
        and public.poller_leases.expires_at > lease_now
      then public.poller_leases.generation
      else public.poller_leases.generation + 1
    end,
    expires_at = excluded.expires_at,
    last_heartbeat_at = excluded.last_heartbeat_at
  where (public.poller_leases.owner = excluded.owner
      and public.poller_leases.event_id = excluded.event_id)
     or public.poller_leases.expires_at <= lease_now
  returning * into lease_row;

  if lease_row.court_id is null then
    return jsonb_build_object('acquired', false, 'generation', null);
  end if;
  return jsonb_build_object('acquired', true, 'generation', lease_row.generation);
end;
$$;

revoke all on function public.try_acquire_poller_lease(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.try_acquire_poller_lease(uuid, uuid, text, integer) to service_role;

create or replace function public.community_commit_provider_score_fenced(
  p_event_id uuid,
  p_court_id uuid,
  p_match_id uuid,
  p_action_id text,
  p_actor_label text,
  p_authority_mode text,
  p_expected_revision bigint,
  p_expected_authority_epoch bigint,
  p_state jsonb,
  p_lease_owner text,
  p_lease_generation bigint,
  p_command_type text default 'CORRECT_SCORE',
  p_team_side text default null,
  p_projection_metadata jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  lease_row public.poller_leases%rowtype;
begin
  select * into lease_row
  from public.poller_leases
  where court_id = p_court_id
  for share;

  if lease_row.court_id is null
    or lease_row.event_id <> p_event_id
    or lease_row.owner <> p_lease_owner
    or lease_row.generation <> p_lease_generation
    or lease_row.expires_at <= clock_timestamp() then
    raise exception 'provider poller lease is stale' using errcode = '40001';
  end if;

  return public.community_commit_trusted_score(
    p_event_id, p_court_id, p_match_id, p_action_id,
    'PROVIDER', p_actor_label, p_authority_mode,
    p_expected_revision, p_expected_authority_epoch, p_state,
    p_command_type, p_team_side, p_projection_metadata, p_metadata
  );
end;
$$;

revoke all on function public.community_commit_provider_score_fenced(
  uuid, uuid, uuid, text, text, text, bigint, bigint, jsonb,
  text, bigint, text, text, jsonb, jsonb
) from public, anon, authenticated;
grant execute on function public.community_commit_provider_score_fenced(
  uuid, uuid, uuid, text, text, text, bigint, bigint, jsonb,
  text, bigint, text, text, jsonb, jsonb
) to service_role;

comment on function public.try_acquire_poller_lease(uuid, uuid, text, integer) is
  'Atomically acquires or renews one court lease and returns its fencing generation.';
comment on function public.community_commit_provider_score_fenced(
  uuid, uuid, uuid, text, text, text, bigint, bigint, jsonb,
  text, bigint, text, text, jsonb, jsonb
) is 'Commits a provider score only while the exact poller lease generation remains current.';
