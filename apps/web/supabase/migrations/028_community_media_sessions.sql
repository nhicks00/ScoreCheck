-- 028: Broker-owned, capacity-admitted WHEP playback for Community Witness.
--
-- Browsers never receive the edge URL, credential, stream path, affinity
-- cookie, or upstream WHEP resource URL.  All access is through the service
-- role and an active match-scoped Community Witness session.

create table public.community_media_sessions (
  id uuid primary key default gen_random_uuid(),
  -- Deliberately no cascading FKs: this is an external-resource cleanup
  -- ledger and must survive parent teardown until upstream DELETE succeeds.
  assignment_id uuid not null,
  event_id uuid not null,
  court_id uuid not null,
  match_id uuid not null,
  status text not null default 'RESERVING' check (status in (
    'RESERVING', 'ACTIVE', 'CLOSE_REQUESTED', 'CLEANING', 'CLOSED', 'FAILED'
  )),
  upstream_resource_url text,
  upstream_affinity_cookie text,
  expires_at timestamptz not null,
  setup_deadline_at timestamptz not null default now() + interval '30 seconds',
  next_cleanup_at timestamptz not null default now(),
  cleanup_attempt_count integer not null default 0 check (cleanup_attempt_count >= 0),
  cleanup_claimed_by text,
  cleanup_claim_token uuid,
  cleanup_claim_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (status <> 'ACTIVE' or upstream_resource_url is not null)
);

create unique index community_media_sessions_one_open_assignment_idx
  on public.community_media_sessions(assignment_id)
  where status in ('RESERVING', 'ACTIVE');

create index community_media_sessions_capacity_idx
  on public.community_media_sessions(event_id, court_id, status, expires_at);

create index community_media_sessions_open_capacity_idx
  on public.community_media_sessions(status, court_id)
  where status in ('RESERVING', 'ACTIVE', 'CLOSE_REQUESTED', 'CLEANING');

create index community_media_sessions_cleanup_idx
  on public.community_media_sessions(status, next_cleanup_at, cleanup_claim_expires_at)
  where status in ('RESERVING', 'ACTIVE', 'CLOSE_REQUESTED', 'CLEANING');

create index community_media_sessions_terminal_retention_idx
  on public.community_media_sessions(closed_at, id)
  where status in ('CLOSED', 'FAILED');

comment on table public.community_media_sessions is
  'Service-only admission and cleanup ledger for opaque Community Witness WHEP resources.';

alter table public.community_media_sessions enable row level security;
alter table public.community_media_sessions force row level security;
revoke all on table public.community_media_sessions from public, anon, authenticated;

-- A bearer invite may authorize the designated role, but it cannot prove that
-- the browser is physically courtside. Public joins rotate the session token,
-- so force grant-backed designated admissions back to REMOTE on insert/rejoin.
-- An authenticated organizer can still verify an onsite observer and promote
-- that same assignment without rotating its session token.
create or replace function public.community_enforce_remote_designated_grant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.grant_id is null or new.role <> 'DESIGNATED_SCORER' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.trust_tier := 'REMOTE';
  elsif new.session_token_hash is distinct from old.session_token_hash then
    new.trust_tier := 'REMOTE';
  end if;
  return new;
end;
$$;

drop trigger if exists community_assignments_remote_designated_grant on public.community_assignments;
create trigger community_assignments_remote_designated_grant
before insert or update of role, trust_tier, session_token_hash, grant_id
on public.community_assignments
for each row execute function public.community_enforce_remote_designated_grant();

-- Fail closed for any active grant-backed designated rows created before this
-- invariant existed. V0 deliberately requires an organizer to re-establish
-- any physical-courtside authority through the verify-then-promote flow.
update public.community_assignments
set trust_tier = 'REMOTE', updated_at = clock_timestamp()
where role = 'DESIGNATED_SCORER'
  and grant_id is not null
  and status = 'ACTIVE'
  and trust_tier <> 'REMOTE';

create or replace function public.community_reserve_media_session(
  p_session_token_hash text,
  p_max_per_court integer,
  p_max_total integer,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_id uuid;
  assignment_row public.community_assignments%rowtype;
  court_row public.courts%rowtype;
  score_row public.score_states%rowtype;
  media_row public.community_media_sessions%rowtype;
  replaced_row public.community_media_sessions%rowtype;
  total_count integer;
  court_count integer;
  reserved_designated_slots integer;
  reserve_current_court_slot boolean;
  observer_total_limit integer;
  observer_court_limit integer;
begin
  if p_session_token_hash is null or char_length(p_session_token_hash) <> 64 then
    raise exception 'invalid community media session' using errcode = '28000';
  end if;
  if p_max_per_court < 1 or p_max_per_court > 5000
    or p_max_total < 1 or p_max_total > 20000
    or p_max_per_court > p_max_total then
    raise exception 'invalid community media capacity' using errcode = '22023';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'invalid community media lease' using errcode = '22023';
  end if;

  -- Pre-read assignment scope without a row lock so media admission can take
  -- locks in the canonical score order below: score, then assignment. The
  -- assignment is re-read and fully revalidated after both locks are held.
  select * into assignment_row
  from public.community_assignments assignment
  where assignment.session_token_hash = p_session_token_hash;

  if assignment_row.id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  assignment_id := assignment_row.id;
  if assignment_row.status <> 'ACTIVE' or assignment_row.lease_expires_at <= now() then
    raise exception 'community assignment is not active' using errcode = 'P0003';
  end if;

  select * into score_row
  from public.score_states score
  where score.match_id = assignment_row.match_id
    and score.court_id = assignment_row.court_id
  for share;
  if score_row.id is null or score_row.court_id <> assignment_row.court_id then
    raise exception 'community score not found' using errcode = 'P0002';
  end if;

  select * into assignment_row
  from public.community_assignments assignment
  where assignment.id = assignment_id
    and assignment.session_token_hash = p_session_token_hash
  for update;
  if assignment_row.id is null
    or assignment_row.status <> 'ACTIVE'
    or assignment_row.lease_expires_at <= now()
    or assignment_row.match_id <> score_row.match_id
    or assignment_row.court_id <> score_row.court_id then
    raise exception 'community assignment changed first' using errcode = '40001';
  end if;

  select * into court_row from public.courts court where court.id = assignment_row.court_id;
  if court_row.id is null
    or court_row.event_id <> assignment_row.event_id
    or court_row.current_match_id is distinct from assignment_row.match_id then
    raise exception 'community court changed first' using errcode = '40001';
  end if;

  -- Capacity is an admission invariant, not an approximate metric. Serialize
  -- globally so concurrent events cannot both count the same final slot and
  -- over-admit the shared read edge.
  perform pg_advisory_xact_lock(hashtextextended(
    'community-media-capacity:global',
    0
  ));

  -- Broker POST is bounded at 15 seconds. After a separate 30-second setup
  -- deadline, a no-resource reservation is provably stale and can be failed
  -- here even if the worker is unavailable.
  update public.community_media_sessions
  set status = 'FAILED',
    last_error = 'stale media setup reservation',
    closed_at = now(),
    updated_at = now()
  where status = 'RESERVING'
    and setup_deadline_at <= now()
    and upstream_resource_url is null;

  -- A reconnect is a replacement, never an additional reader. The broker must
  -- close this resource before opening the newly reserved one.
  select * into replaced_row
  from public.community_media_sessions media
  where media.assignment_id = assignment_row.id
    and (
      media.status = 'RESERVING'
      or (
        media.status in ('ACTIVE', 'CLOSE_REQUESTED', 'CLEANING')
        and media.upstream_resource_url is not null
      )
    )
  order by media.created_at desc
  limit 1
  for update;

  -- A second broker request cannot safely replace a reservation whose
  -- upstream POST may still be in flight and whose resource URL is not known
  -- yet. Keep its capacity slot until that request activates or fails.
  if replaced_row.status = 'RESERVING' then
    raise exception 'community media reservation is still opening' using errcode = '55000';
  end if;
  if replaced_row.status in ('CLOSE_REQUESTED', 'CLEANING') then
    raise exception 'previous community media resource is still closing' using errcode = '55000';
  end if;

  if replaced_row.id is not null then
    update public.community_media_sessions
    set status = 'CLOSE_REQUESTED',
      next_cleanup_at = now(),
      cleanup_claimed_by = null,
      cleanup_claim_token = null,
      cleanup_claim_expires_at = null,
      updated_at = now()
    where id = replaced_row.id;
  end if;

  -- A resource continues to consume edge capacity until cleanup succeeds,
  -- even after its browser lease expires or cleanup is requested. Only this
  -- assignment's explicit replacement is excluded: the broker synchronously
  -- closes it before opening the new upstream session.
  select count(*) into total_count
  from public.community_media_sessions media
  where media.id is distinct from replaced_row.id
    and (
      media.status = 'RESERVING'
      or (
        media.status in ('ACTIVE', 'CLOSE_REQUESTED', 'CLEANING')
        and media.upstream_resource_url is not null
      )
    );

  select count(*) into court_count
  from public.community_media_sessions media
  where media.court_id = assignment_row.court_id
    and media.id is distinct from replaced_row.id
    and (
      media.status = 'RESERVING'
      or (
        media.status in ('ACTIVE', 'CLOSE_REQUESTED', 'CLEANING')
        and media.upstream_resource_url is not null
      )
    );

  -- Ordinary viewers cannot consume the last scorer slot on a live court.
  -- Reserve one global slot for every active-event court that lacks a
  -- capacity-consuming designated feed; the same advisory lock serializes
  -- this calculation with every admission decision.
  select count(*) into reserved_designated_slots
  from public.courts live_court
  join public.events live_event
    on live_event.id = live_court.event_id and live_event.is_active = true
  where live_court.scoring_open = true
    and live_court.frozen = false
    and live_court.current_match_id is not null
    and not exists (
      select 1
      from public.community_media_sessions designated_media
      join public.community_assignments designated_assignment
        on designated_assignment.id = designated_media.assignment_id
      where designated_media.court_id = live_court.id
        and designated_media.match_id = live_court.current_match_id
        and designated_assignment.role = 'DESIGNATED_SCORER'
        and designated_media.status in ('RESERVING', 'ACTIVE')
    );
  reserve_current_court_slot := court_row.scoring_open is true
    and court_row.frozen is false
    and exists (
      select 1 from public.events current_event
      where current_event.id = assignment_row.event_id
        and current_event.is_active = true
    )
    and not exists (
    select 1
    from public.community_media_sessions designated_media
    join public.community_assignments designated_assignment
      on designated_assignment.id = designated_media.assignment_id
    where designated_media.court_id = assignment_row.court_id
      and designated_media.match_id = assignment_row.match_id
      and designated_assignment.role = 'DESIGNATED_SCORER'
      and designated_media.status in ('RESERVING', 'ACTIVE')
    );
  observer_total_limit := greatest(0, p_max_total - reserved_designated_slots);
  observer_court_limit := greatest(0, p_max_per_court - case when reserve_current_court_slot then 1 else 0 end);

  if total_count >= p_max_total or court_count >= p_max_per_court
    or (
      assignment_row.role <> 'DESIGNATED_SCORER'
      and (total_count >= observer_total_limit or court_count >= observer_court_limit)
    ) then
    raise exception 'community media capacity reached' using errcode = 'P0004';
  end if;

  insert into public.community_media_sessions (
    assignment_id, event_id, court_id, match_id, expires_at
  ) values (
    assignment_row.id,
    assignment_row.event_id,
    assignment_row.court_id,
    assignment_row.match_id,
    least(assignment_row.lease_expires_at, now() + make_interval(secs => p_lease_seconds))
  ) returning * into media_row;

  return jsonb_build_object(
    'id', media_row.id,
    'assignmentId', assignment_row.id,
    'eventId', assignment_row.event_id,
    'courtId', assignment_row.court_id,
    'matchId', assignment_row.match_id,
    'courtNumber', court_row.court_number,
    'previewStreamPath', nullif(btrim(court_row.preview_stream_path), ''),
    'expiresAt', media_row.expires_at,
    'replaced', case when replaced_row.id is null then null else jsonb_build_object(
      'id', replaced_row.id,
      'upstreamResourceUrl', replaced_row.upstream_resource_url,
      'upstreamAffinityCookie', replaced_row.upstream_affinity_cookie
    ) end
  );
end;
$$;

create or replace function public.community_activate_media_session(
  p_session_token_hash text,
  p_media_session_id uuid,
  p_upstream_resource_url text,
  p_upstream_affinity_cookie text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
  media_row public.community_media_sessions%rowtype;
begin
  if p_upstream_resource_url is null
    or char_length(p_upstream_resource_url) < 8
    or char_length(p_upstream_resource_url) > 4096
    or char_length(coalesce(p_upstream_affinity_cookie, '')) > 2048 then
    raise exception 'invalid upstream media resource' using errcode = '22023';
  end if;

  -- Lock assignment first, matching reserve/release ordering. This prevents an
  -- activation snapshot from racing past a concurrent assignment release and
  -- leaving an ACTIVE resource attached to a terminal session.
  select * into assignment_row
  from public.community_assignments assignment
  where assignment.session_token_hash = p_session_token_hash
  for update;
  if assignment_row.id is null
    or assignment_row.status <> 'ACTIVE'
    or assignment_row.lease_expires_at <= now() then
    raise exception 'community media reservation is no longer active' using errcode = 'P0003';
  end if;

  select * into media_row
  from public.community_media_sessions media
  where media.id = p_media_session_id
    and media.assignment_id = assignment_row.id
  for update;
  if media_row.id is null
    or media_row.status <> 'RESERVING'
    or media_row.setup_deadline_at <= now()
    or media_row.expires_at <= now() then
    raise exception 'community media reservation is no longer active' using errcode = 'P0003';
  end if;

  update public.community_media_sessions
  set status = 'ACTIVE',
    upstream_resource_url = p_upstream_resource_url,
    upstream_affinity_cookie = nullif(p_upstream_affinity_cookie, ''),
    activated_at = now(),
    updated_at = now()
  where id = media_row.id
  returning * into media_row;
  return jsonb_build_object('ok', true, 'id', media_row.id, 'expiresAt', media_row.expires_at);
end;
$$;

create or replace function public.community_fail_media_session(
  p_media_session_id uuid,
  p_error text default null,
  p_upstream_resource_url text default null,
  p_upstream_affinity_cookie text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_upstream_resource_url is not null and (
      char_length(p_upstream_resource_url) < 8
      or char_length(p_upstream_resource_url) > 4096
    )
    or char_length(coalesce(p_upstream_affinity_cookie, '')) > 2048
    or (p_upstream_affinity_cookie is not null and p_upstream_resource_url is null) then
    raise exception 'invalid upstream media cleanup resource' using errcode = '22023';
  end if;

  if p_upstream_resource_url is not null then
    -- The upstream POST succeeded but activation or immediate DELETE failed.
    -- Persist the opaque resource even if a concurrent release already moved
    -- this reservation through CLEANING/CLOSED, so the reaper cannot lose it.
    update public.community_media_sessions
    set status = 'CLOSE_REQUESTED',
      upstream_resource_url = p_upstream_resource_url,
      upstream_affinity_cookie = nullif(p_upstream_affinity_cookie, ''),
      next_cleanup_at = now(),
      cleanup_claimed_by = null,
      cleanup_claim_token = null,
      cleanup_claim_expires_at = null,
      last_error = left(coalesce(p_error, 'upstream setup cleanup required'), 500),
      closed_at = null,
      updated_at = now()
    where id = p_media_session_id;
    return;
  end if;

  update public.community_media_sessions
  set status = 'FAILED',
    last_error = left(coalesce(p_error, 'upstream setup failed'), 500),
    closed_at = now(),
    cleanup_claimed_by = null,
    cleanup_claim_token = null,
    cleanup_claim_expires_at = null,
    updated_at = now()
  where id = p_media_session_id
    and status in ('RESERVING', 'CLOSE_REQUESTED')
    and upstream_resource_url is null;
end;
$$;

create or replace function public.community_touch_media_sessions(
  p_session_token_hash text,
  p_lease_seconds integer default 120
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  touched integer;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'invalid community media lease' using errcode = '22023';
  end if;

  update public.community_media_sessions media
  set expires_at = least(assignment.lease_expires_at, now() + make_interval(secs => p_lease_seconds)),
    updated_at = now()
  from public.community_assignments assignment
  where media.assignment_id = assignment.id
    and assignment.session_token_hash = p_session_token_hash
    and assignment.status = 'ACTIVE'
    and assignment.lease_expires_at > now()
    and media.status in ('RESERVING', 'ACTIVE')
    and media.expires_at <= now() + make_interval(secs => greatest(15, p_lease_seconds / 2));
  get diagnostics touched = row_count;
  return touched;
end;
$$;

create or replace function public.community_claim_media_session_close(
  p_session_token_hash text,
  p_media_session_id uuid,
  p_claimed_by text,
  p_cleanup_claim_token uuid,
  p_lease_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  media_row public.community_media_sessions%rowtype;
begin
  if char_length(btrim(coalesce(p_claimed_by, ''))) < 1
    or char_length(p_claimed_by) > 120
    or p_cleanup_claim_token is null
    or p_lease_seconds < 5 or p_lease_seconds > 120 then
    raise exception 'invalid media cleanup claim' using errcode = '22023';
  end if;

  update public.community_media_sessions media
  set status = 'CLEANING',
    cleanup_claimed_by = p_claimed_by,
    cleanup_claim_token = p_cleanup_claim_token,
    cleanup_claim_expires_at = now() + make_interval(secs => p_lease_seconds),
    updated_at = now()
  from public.community_assignments assignment
  where media.id = p_media_session_id
    and media.assignment_id = assignment.id
    and assignment.session_token_hash = p_session_token_hash
    and media.status in ('ACTIVE', 'CLOSE_REQUESTED')
    and (media.cleanup_claim_expires_at is null or media.cleanup_claim_expires_at <= now())
  returning media.* into media_row;

  if media_row.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'id', media_row.id,
    'cleanupClaimToken', media_row.cleanup_claim_token,
    'upstreamResourceUrl', media_row.upstream_resource_url,
    'upstreamAffinityCookie', media_row.upstream_affinity_cookie
  );
end;
$$;

create or replace function public.community_request_media_session_close(
  p_session_token_hash text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  requested integer;
begin
  update public.community_media_sessions media
  set status = 'CLOSE_REQUESTED',
    next_cleanup_at = now(),
    cleanup_claimed_by = null,
    cleanup_claim_token = null,
    cleanup_claim_expires_at = null,
    updated_at = now()
  from public.community_assignments assignment
  where media.assignment_id = assignment.id
    and assignment.session_token_hash = p_session_token_hash
    and media.status = 'ACTIVE';
  get diagnostics requested = row_count;
  return requested;
end;
$$;

create or replace function public.community_claim_media_cleanup(
  p_worker_id text,
  p_cleanup_claim_token uuid,
  p_limit integer default 20,
  p_lease_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  if char_length(btrim(coalesce(p_worker_id, ''))) < 1
    or char_length(p_worker_id) > 120
    or p_cleanup_claim_token is null
    or p_limit < 1 or p_limit > 100
    or p_lease_seconds < 5 or p_lease_seconds > 120 then
    raise exception 'invalid media cleanup request' using errcode = '22023';
  end if;

  update public.community_media_sessions media
  set status = 'CLOSE_REQUESTED',
    next_cleanup_at = now(),
    cleanup_claimed_by = null,
    cleanup_claim_token = null,
    cleanup_claim_expires_at = null,
    updated_at = now()
  where (
      media.status in ('RESERVING', 'ACTIVE')
      and media.expires_at <= now()
    ) or (
      media.status = 'CLEANING'
      and (media.cleanup_claim_expires_at is null or media.cleanup_claim_expires_at <= now())
    );

  with candidates as (
    select media.id
    from public.community_media_sessions media
    where media.status = 'CLOSE_REQUESTED'
      and media.next_cleanup_at <= now()
      and (media.cleanup_claim_expires_at is null or media.cleanup_claim_expires_at <= now())
    order by media.next_cleanup_at, media.created_at
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.community_media_sessions media
    set status = 'CLEANING',
      cleanup_claimed_by = p_worker_id,
      cleanup_claim_token = p_cleanup_claim_token,
      cleanup_claim_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from candidates
    where media.id = candidates.id
    returning media.id, media.cleanup_claim_token, media.upstream_resource_url, media.upstream_affinity_cookie
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', claimed.id,
    'cleanupClaimToken', claimed.cleanup_claim_token,
    'upstreamResourceUrl', claimed.upstream_resource_url,
    'upstreamAffinityCookie', claimed.upstream_affinity_cookie
  )), '[]'::jsonb) into result
  from claimed;

  return result;
end;
$$;

create or replace function public.community_finish_media_cleanup(
  p_media_session_id uuid,
  p_claimed_by text,
  p_cleanup_claim_token uuid,
  p_succeeded boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  attempts integer;
begin
  select cleanup_attempt_count into attempts
  from public.community_media_sessions
  where id = p_media_session_id
    and status = 'CLEANING'
    and cleanup_claimed_by = p_claimed_by
    and cleanup_claim_token = p_cleanup_claim_token
  for update;

  if attempts is null then
    return;
  end if;

  if p_succeeded then
    update public.community_media_sessions
    set status = 'CLOSED',
      closed_at = now(),
      last_error = null,
      upstream_resource_url = null,
      upstream_affinity_cookie = null,
      cleanup_claimed_by = null,
      cleanup_claim_token = null,
      cleanup_claim_expires_at = null,
      updated_at = now()
    where id = p_media_session_id
      and cleanup_claimed_by = p_claimed_by
      and cleanup_claim_token = p_cleanup_claim_token;
  else
    attempts := attempts + 1;
    update public.community_media_sessions
    set status = 'CLOSE_REQUESTED',
      cleanup_attempt_count = attempts,
      next_cleanup_at = now() + make_interval(secs => least(60, (2 ^ least(attempts, 5))::integer)),
      last_error = left(coalesce(p_error, 'upstream cleanup failed'), 500),
      cleanup_claimed_by = null,
      cleanup_claim_token = null,
      cleanup_claim_expires_at = null,
      updated_at = now()
    where id = p_media_session_id
      and cleanup_claimed_by = p_claimed_by
      and cleanup_claim_token = p_cleanup_claim_token;
  end if;
end;
$$;

create or replace function public.community_close_media_on_assignment_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.status <> 'ACTIVE'
    or new.match_id is distinct from old.match_id
    or new.court_id is distinct from old.court_id then
    update public.community_media_sessions
    set status = 'CLOSE_REQUESTED',
      next_cleanup_at = now(),
      cleanup_claimed_by = null,
      cleanup_claim_token = null,
      cleanup_claim_expires_at = null,
      updated_at = now()
    where assignment_id = old.id and status = 'ACTIVE';
  end if;
  return new;
end;
$$;

drop trigger if exists community_assignments_close_media on public.community_assignments;
create trigger community_assignments_close_media
after update of status, match_id, court_id on public.community_assignments
for each row execute function public.community_close_media_on_assignment_change();

-- Remote designated-scorer playback evidence is retained briefly next to the
-- accepted canonical action. Ordinary crowd observations do not store frame
-- diagnostics: they are already untrusted evidence and would multiply storage
-- by every viewer on every rally.
create table public.community_playback_evidence (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.community_assignments(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  client_action_id text not null check (char_length(client_action_id) between 8 and 128),
  base_revision bigint not null check (base_revision >= 0),
  action_type text not null check (action_type in ('ADD_POINT', 'REMOVE_POINT')),
  team_side text not null check (team_side in ('A', 'B')),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  recorded_at timestamptz not null default now(),
  unique (assignment_id, client_action_id)
);

comment on table public.community_playback_evidence is
  'Short-lived, update-immutable remote-scorer playback diagnostics for accepted canonical point commands; never source-frame authority.';

create index community_playback_evidence_retention_idx
  on public.community_playback_evidence(recorded_at, id);

alter table public.community_playback_evidence enable row level security;
alter table public.community_playback_evidence force row level security;
revoke all on table public.community_playback_evidence from public, anon, authenticated;

drop trigger if exists community_playback_evidence_immutable on public.community_playback_evidence;
drop trigger if exists community_playback_evidence_immutable_update on public.community_playback_evidence;
create trigger community_playback_evidence_immutable_update
before update on public.community_playback_evidence
for each row execute function public.community_reject_immutable_mutation();

create or replace function public.community_record_playback_evidence(
  p_session_token_hash text,
  p_client_action_id text,
  p_base_revision bigint,
  p_action_type text,
  p_team_side text,
  p_evidence jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
begin
  select * into assignment_row
  from public.community_assignments assignment
  where assignment.session_token_hash = p_session_token_hash;
  if assignment_row.id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  if p_client_action_id is null or char_length(p_client_action_id) < 8 or char_length(p_client_action_id) > 128
    or p_base_revision < 0
    or p_action_type not in ('ADD_POINT', 'REMOVE_POINT')
    or p_team_side not in ('A', 'B')
    or p_evidence is null or jsonb_typeof(p_evidence) <> 'object'
    or pg_column_size(p_evidence) > 16384
    or p_evidence->>'correlation' <> 'uncorrelated_client_diagnostic'
    or coalesce((p_evidence->>'baseRevision')::bigint, -1) <> p_base_revision then
    raise exception 'invalid community playback evidence' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.canonical_score_events event
    where event.assignment_id = assignment_row.id
      and event.command_id = p_client_action_id
      and event.revision = p_base_revision + 1
      and event.previous_state is not null
      and event.command_type = p_action_type
      and event.team_side = p_team_side
  ) then
    raise exception 'playback evidence has no accepted rally action' using errcode = '23514';
  end if;

  insert into public.community_playback_evidence (
    assignment_id, event_id, court_id, match_id, client_action_id,
    base_revision, action_type, team_side, evidence
  ) values (
    assignment_row.id, assignment_row.event_id, assignment_row.court_id,
    assignment_row.match_id, p_client_action_id, p_base_revision,
    p_action_type, p_team_side, p_evidence
  ) on conflict (assignment_id, client_action_id) do nothing;
  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid community playback evidence' using errcode = '22023';
end;
$$;

-- Remote point and current-set commands are admitted only while the scorer is
-- watching a qualified brokered frame. Point diagnostics are persisted beside
-- the canonical event; set selection uses the same transactional media check
-- without pretending that a frame proves which set is being played. An
-- organizer-verified courtside scorer may instead use direct sight of the
-- physical court; commentary and other remote scorers never receive that
-- exemption.
create or replace function public.community_submit_scorer_command_with_evidence(
  p_session_token_hash text,
  p_client_action_id text,
  p_expected_revision bigint,
  p_action jsonb,
  p_playback_evidence jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
  assignment_row public.community_assignments%rowtype;
  media_row public.community_media_sessions%rowtype;
  action_type text := p_action->>'type';
  team_side text := p_action->>'team';
  evidence_session_id text;
  media_session_id uuid;
  reported_frame_age numeric;
begin
  if action_type not in ('ADD_POINT', 'REMOVE_POINT', 'SET_CURRENT_SET') then
    if p_playback_evidence is not null then
      raise exception 'playback evidence is valid only for live-authoritative commands' using errcode = '22023';
    end if;
    return public.community_submit_scorer_command(
      p_session_token_hash, p_client_action_id, p_expected_revision, p_action
    );
  end if;

  -- The canonical command obtains score then assignment locks. All checks
  -- below remain in this RPC transaction, so any later rejection rolls it
  -- back before the outbox becomes visible.
  result := public.community_submit_scorer_command(
    p_session_token_hash, p_client_action_id, p_expected_revision, p_action
  );
  select * into assignment_row
  from public.community_assignments assignment
  where assignment.session_token_hash = p_session_token_hash;

  -- Retries prove idempotency against the durable canonical command. They do
  -- not re-authorize an already-accepted point against today's media lease.
  if coalesce((result->>'duplicate')::boolean, false) then
    return result;
  end if;

  if assignment_row.trust_tier = 'VERIFIED_COURTSIDE' and p_playback_evidence is null then
    return result;
  end if;
  if p_playback_evidence is null or jsonb_typeof(p_playback_evidence) <> 'object' then
    raise exception 'remote authoritative command requires qualified playback evidence' using errcode = 'P0005';
  end if;

  if jsonb_typeof(p_playback_evidence->'frame') is distinct from 'object'
    or jsonb_typeof(p_playback_evidence->'qualification') is distinct from 'object'
    or p_playback_evidence->>'sampledAtMs' is null
    or p_playback_evidence #>> '{frame,observedAtMs}' is null then
    raise exception 'authoritative command playback evidence is incomplete' using errcode = 'P0005';
  end if;

  evidence_session_id := p_playback_evidence->>'sessionId';
  if evidence_session_id is null
    or evidence_session_id !~* '^whep-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'authoritative command playback session is not brokered' using errcode = 'P0005';
  end if;
  media_session_id := substring(evidence_session_id from 6)::uuid;
  reported_frame_age := greatest(
    0,
    (p_playback_evidence->>'sampledAtMs')::numeric
      - (p_playback_evidence #>> '{frame,observedAtMs}')::numeric
  );
  -- sampledAtMs and frame.observedAtMs share the browser monotonic clock.
  -- Their difference is useful for accidental stale-frame prevention, but an
  -- absolute browser timestamp is neither trusted nor comparable to the DB
  -- clock because device wall clocks can be skewed.
  if p_playback_evidence->>'correlation' is distinct from 'uncorrelated_client_diagnostic'
    or (p_playback_evidence->>'baseRevision')::bigint is distinct from p_expected_revision
    or p_playback_evidence->>'transport' is distinct from 'whep'
    or p_playback_evidence->>'connectionState' is distinct from 'connected'
    or (p_playback_evidence->>'paused')::boolean is not false
    or (p_playback_evidence->>'stalled')::boolean is not false
    or (p_playback_evidence->>'reconnecting')::boolean is not false
    or (p_playback_evidence->>'readyState')::integer < 2
    or (p_playback_evidence->>'videoWidth')::integer < 1
    or (p_playback_evidence->>'videoHeight')::integer < 1
    or p_playback_evidence #>> '{frame,sessionId}' is distinct from evidence_session_id
    or (p_playback_evidence #>> '{qualification,liveActionEligible}')::boolean is not true
    or p_playback_evidence #>> '{qualification,blockedReason}' is not null
    or (p_playback_evidence #>> '{qualification,maxFrameAgeMs}')::integer is distinct from 1500
    or (p_playback_evidence #>> '{qualification,frameAgeMs}')::numeric is distinct from reported_frame_age
    or reported_frame_age > 1500 then
    raise exception 'authoritative command playback evidence is not qualified' using errcode = 'P0005';
  end if;

  select media.* into media_row
  from public.community_media_sessions media
  where media.id = media_session_id
    and media.assignment_id = assignment_row.id
    and media.event_id = assignment_row.event_id
    and media.court_id = assignment_row.court_id
    and media.match_id = assignment_row.match_id
    and media.status = 'ACTIVE'
    and media.expires_at > clock_timestamp()
  for share;
  if media_row.id is null then
    raise exception 'authoritative command playback session is no longer active' using errcode = 'P0005';
  end if;

  if action_type in ('ADD_POINT', 'REMOVE_POINT') then
    perform public.community_record_playback_evidence(
      p_session_token_hash,
      p_client_action_id,
      p_expected_revision,
      action_type,
      team_side,
      p_playback_evidence
    );
  end if;
  return result;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'authoritative command playback evidence is invalid' using errcode = 'P0005';
end;
$$;

-- Trusted commentary users are remote, not organizer-verified courtside
-- scorers. Service-side creation may grant them a designated seat, but that
-- seat remains subject to the WHEP evidence requirement above.
create or replace function public.community_create_trusted_assignment(
  p_event_id uuid,
  p_court_id uuid,
  p_match_id uuid,
  p_display_name text,
  p_session_token_hash text,
  p_role text,
  p_trust_tier text default 'VERIFIED_COURTSIDE',
  p_lease_seconds integer default 120,
  p_action_id text default null,
  p_actor_label text default 'Trusted assignment'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  court_row public.courts%rowtype;
  assignment_row public.community_assignments%rowtype;
  existing_assignment public.community_assignments%rowtype;
  score_row public.score_states%rowtype;
  new_epoch bigint;
  action_id text := coalesce(p_action_id, gen_random_uuid()::text);
begin
  if p_role not in ('OBSERVER', 'VERIFIED_WITNESS', 'DESIGNATED_SCORER')
    or p_trust_tier not in ('REMOTE', 'COURTSIDE', 'VERIFIED_COURTSIDE') then
    raise exception 'trusted assignment role or trust tier is invalid' using errcode = '22023';
  end if;
  if p_role = 'VERIFIED_WITNESS' and p_trust_tier <> 'VERIFIED_COURTSIDE' then
    raise exception 'verified witness roles require verified courtside trust' using errcode = '23514';
  end if;
  if p_role = 'DESIGNATED_SCORER'
    and p_trust_tier not in ('REMOTE', 'VERIFIED_COURTSIDE') then
    raise exception 'designated scorers must be remote or verified courtside' using errcode = '23514';
  end if;
  if char_length(btrim(coalesce(p_display_name, ''))) < 1
    or char_length(p_display_name) > 80
    or p_session_token_hash is null or char_length(p_session_token_hash) <> 64
    or p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'trusted assignment input is invalid' using errcode = '22023';
  end if;

  select * into court_row from public.courts where id = p_court_id for update;
  if court_row.id is null
    or court_row.event_id <> p_event_id
    or court_row.current_match_id <> p_match_id then
    raise exception 'trusted assignment scope is not current' using errcode = '23514';
  end if;
  if p_role = 'DESIGNATED_SCORER'
    and (court_row.scoring_open is not true or court_row.frozen is true) then
    raise exception 'closed or frozen courts cannot assign a designated scorer' using errcode = '23514';
  end if;

  select * into existing_assignment
  from public.community_assignments
  where session_token_hash = p_session_token_hash;
  if existing_assignment.id is not null then
    return public.community_session_response(existing_assignment.id, true, null, null);
  end if;

  score_row := public.community_ensure_score_projection(
    p_event_id, p_court_id, p_match_id, 'PAUSED_DISPUTE'
  );
  new_epoch := score_row.authority_epoch;
  if p_role = 'DESIGNATED_SCORER' then
    if score_row.authority_mode in ('ADMIN_LOCKED', 'PROVIDER_PRIMARY') then
      raise exception 'current source authority does not permit designation' using errcode = '55000';
    end if;
    update public.community_assignments
    set status = 'EXPIRED', updated_at = clock_timestamp()
    where match_id = p_match_id
      and role = 'DESIGNATED_SCORER'
      and status = 'ACTIVE'
      and lease_expires_at <= clock_timestamp();
    if exists (
      select 1 from public.community_assignments
      where match_id = p_match_id
        and role = 'DESIGNATED_SCORER'
        and status = 'ACTIVE'
        and lease_expires_at > clock_timestamp()
    ) then
      raise exception 'this match already has a designated scorer' using errcode = '23505';
    end if;
    new_epoch := score_row.authority_epoch + 1;
  end if;

  insert into public.community_assignments (
    event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, authority_epoch, lease_expires_at, last_seen_at
  ) values (
    p_event_id, p_court_id, p_match_id, p_session_token_hash, btrim(p_display_name),
    p_role, p_trust_tier, new_epoch,
    clock_timestamp() + make_interval(secs => p_lease_seconds), clock_timestamp()
  ) returning * into assignment_row;

  if p_role = 'DESIGNATED_SCORER' then
    update public.score_states
    set authority_epoch = new_epoch,
      authority_mode = 'DESIGNATED_PRIMARY',
      updated_at = clock_timestamp()
    where id = score_row.id
    returning * into score_row;
    insert into public.canonical_score_events (
      event_id, court_id, match_id, assignment_id, revision, authority_epoch,
      authority_mode, command_id, command_type, actor_type, actor_label,
      previous_state, next_state, state_hash, metadata
    ) values (
      p_event_id, p_court_id, p_match_id, assignment_row.id, score_row.revision,
      new_epoch, 'DESIGNATED_PRIMARY', action_id, 'AUTHORITY_CHANGE', 'SYSTEM',
      p_actor_label, public.community_score_input_json(score_row),
      public.community_score_input_json(score_row), score_row.state_hash,
      jsonb_build_object('reason', 'trusted_designated_assignment')
    );
  end if;

  return public.community_session_response(assignment_row.id, false, null, null);
end;
$$;

-- A commentary scorer already holds a remote observer assignment and an
-- HttpOnly session token. Promote that assignment instead of replacing it so
-- a lost HTTP response can be recovered with the same cookie and any active
-- WHEP resource remains bound to the same assignment. The client action id is
-- the durable idempotency key for concurrent or repeated claim requests.
create or replace function public.community_claim_trusted_designated_assignment(
  p_event_id uuid,
  p_court_id uuid,
  p_match_id uuid,
  p_session_token_hash text,
  p_display_name text,
  p_lease_seconds integer default 120,
  p_action_id text default null,
  p_actor_label text default 'Trusted designated assignment claim'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  scoped_assignment public.community_assignments%rowtype;
  assignment_row public.community_assignments%rowtype;
  court_row public.courts%rowtype;
  score_row public.score_states%rowtype;
  authority_event public.canonical_score_events%rowtype;
  new_epoch bigint;
begin
  if p_session_token_hash is null or char_length(p_session_token_hash) <> 64
    or char_length(btrim(coalesce(p_display_name, ''))) < 1
    or char_length(p_display_name) > 80
    or p_lease_seconds < 30 or p_lease_seconds > 600
    or p_action_id is null or char_length(p_action_id) < 8
    or char_length(p_action_id) > 128 then
    raise exception 'trusted designated claim input is invalid' using errcode = '22023';
  end if;

  -- Pre-read scope without a row lock, then acquire the canonical
  -- court -> score -> assignment order and revalidate every binding.
  select * into scoped_assignment
  from public.community_assignments assignment
  where assignment.session_token_hash = p_session_token_hash;
  if scoped_assignment.id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  if scoped_assignment.event_id <> p_event_id
    or scoped_assignment.court_id <> p_court_id
    or scoped_assignment.match_id <> p_match_id then
    raise exception 'commentary assignment scope is not current' using errcode = '23514';
  end if;

  select * into court_row
  from public.courts court
  where court.id = p_court_id
  for update;
  if court_row.id is null
    or court_row.event_id <> p_event_id
    or court_row.current_match_id is distinct from p_match_id then
    raise exception 'commentary assignment scope is not current' using errcode = '23514';
  end if;

  score_row := public.community_ensure_score_projection(
    p_event_id, p_court_id, p_match_id, 'PAUSED_DISPUTE'
  );

  select * into assignment_row
  from public.community_assignments assignment
  where assignment.id = scoped_assignment.id
    and assignment.session_token_hash = p_session_token_hash
  for update;
  if assignment_row.id is null
    or assignment_row.event_id <> p_event_id
    or assignment_row.court_id <> p_court_id
    or assignment_row.match_id <> p_match_id then
    raise exception 'commentary assignment changed first' using errcode = '40001';
  end if;

  select * into authority_event
  from public.canonical_score_events event
  where event.command_id = p_action_id;
  if authority_event.id is not null then
    if authority_event.assignment_id is distinct from assignment_row.id
      or authority_event.match_id <> p_match_id
      or authority_event.command_type <> 'ASSIGNMENT_PROMOTED'
      or authority_event.metadata->>'reason' <> 'trusted_designated_assignment_claim' then
      raise exception 'trusted designated claim action id was reused' using errcode = '23514';
    end if;
    if assignment_row.status <> 'ACTIVE'
      or assignment_row.lease_expires_at <= clock_timestamp()
      or assignment_row.role <> 'DESIGNATED_SCORER'
      or assignment_row.trust_tier <> 'REMOTE' then
      raise exception 'community assignment is no longer active' using errcode = 'P0003';
    end if;
    update public.community_assignments
    set display_name = btrim(p_display_name),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_seen_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where id = assignment_row.id
    returning * into assignment_row;
    return public.community_session_response(
      assignment_row.id, true, authority_event.id, null
    );
  end if;

  if assignment_row.status <> 'ACTIVE'
    or assignment_row.lease_expires_at <= clock_timestamp() then
    raise exception 'community assignment is no longer active' using errcode = 'P0003';
  end if;
  if assignment_row.trust_tier <> 'REMOTE'
    or assignment_row.role not in ('OBSERVER', 'DESIGNATED_SCORER') then
    raise exception 'only a remote commentary viewer can take this scorer seat' using errcode = '23514';
  end if;

  -- A repeated request with a fresh action id is also safe after a page
  -- reload: the same token already owns the seat, so only renew its lease.
  if assignment_row.role = 'DESIGNATED_SCORER' then
    update public.community_assignments
    set display_name = btrim(p_display_name),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_seen_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where id = assignment_row.id
    returning * into assignment_row;
    return public.community_session_response(assignment_row.id, true, null, null);
  end if;

  if court_row.scoring_open is not true or court_row.frozen is true then
    raise exception 'closed or frozen courts cannot assign a designated scorer' using errcode = '23514';
  end if;
  if score_row.authority_mode in ('ADMIN_LOCKED', 'PROVIDER_PRIMARY') then
    raise exception 'current source authority does not permit designation' using errcode = '55000';
  end if;

  update public.community_assignments
  set status = 'EXPIRED',
    ended_at = coalesce(ended_at, clock_timestamp()),
    updated_at = clock_timestamp()
  where match_id = p_match_id
    and id <> assignment_row.id
    and role = 'DESIGNATED_SCORER'
    and status = 'ACTIVE'
    and lease_expires_at <= clock_timestamp();
  if exists (
    select 1 from public.community_assignments assignment
    where assignment.match_id = p_match_id
      and assignment.id <> assignment_row.id
      and assignment.role = 'DESIGNATED_SCORER'
      and assignment.status = 'ACTIVE'
      and assignment.lease_expires_at > clock_timestamp()
  ) then
    raise exception 'this match already has a designated scorer' using errcode = '23505';
  end if;

  new_epoch := score_row.authority_epoch + 1;
  update public.community_assignments
  set display_name = btrim(p_display_name),
    role = 'DESIGNATED_SCORER',
    authority_epoch = new_epoch,
    lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
    last_seen_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = assignment_row.id
  returning * into assignment_row;

  update public.score_states
  set authority_epoch = new_epoch,
    authority_mode = 'DESIGNATED_PRIMARY',
    updated_at = clock_timestamp()
  where id = score_row.id
  returning * into score_row;

  insert into public.canonical_score_events (
    event_id, court_id, match_id, assignment_id, revision, authority_epoch,
    authority_mode, command_id, command_type, actor_type, actor_label,
    previous_state, next_state, state_hash, metadata
  ) values (
    p_event_id, p_court_id, p_match_id, assignment_row.id, score_row.revision,
    new_epoch, 'DESIGNATED_PRIMARY', p_action_id, 'ASSIGNMENT_PROMOTED', 'SYSTEM',
    p_actor_label, public.community_score_input_json(score_row),
    public.community_score_input_json(score_row), score_row.state_hash,
    jsonb_build_object('reason', 'trusted_designated_assignment_claim')
  ) returning * into authority_event;

  return public.community_session_response(
    assignment_row.id, false, authority_event.id, null
  );
end;
$$;

create or replace function public.community_scorer_command_recorded(
  p_session_token_hash text,
  p_client_action_id text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_session_token_hash is null or char_length(p_session_token_hash) <> 64
    or p_client_action_id is null or char_length(p_client_action_id) < 8
    or char_length(p_client_action_id) > 128 then
    raise exception 'invalid score receipt check' using errcode = '22023';
  end if;
  return exists (
    select 1
    from public.community_assignments assignment
    join public.canonical_score_events event
      on event.assignment_id = assignment.id
      and event.command_id = p_client_action_id
      and event.command_type in ('ADD_POINT', 'REMOVE_POINT')
    where assignment.session_token_hash = p_session_token_hash
  );
end;
$$;

create or replace function public.community_prune_media_history(
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  evidence_deleted integer := 0;
  media_deleted integer := 0;
begin
  if p_limit < 1 or p_limit > 5000 then
    raise exception 'invalid community media prune limit' using errcode = '22023';
  end if;

  with doomed as (
    select evidence.id
    from public.community_playback_evidence evidence
    where evidence.recorded_at < now() - interval '7 days'
    order by evidence.recorded_at, evidence.id
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from public.community_playback_evidence evidence
    using doomed
    where evidence.id = doomed.id
    returning evidence.id
  )
  select count(*)::integer into evidence_deleted from deleted;

  with doomed as (
    select media.id
    from public.community_media_sessions media
    where media.status in ('CLOSED', 'FAILED')
      and coalesce(media.closed_at, media.updated_at) < now() - interval '24 hours'
    order by coalesce(media.closed_at, media.updated_at), media.id
    for update skip locked
    limit p_limit
  ), deleted as (
    delete from public.community_media_sessions media
    using doomed
    where media.id = doomed.id
    returning media.id
  )
  select count(*)::integer into media_deleted from deleted;

  return jsonb_build_object(
    'playbackEvidenceDeleted', evidence_deleted,
    'mediaSessionsDeleted', media_deleted
  );
end;
$$;

-- Community DTO hard cut: the scorekeeper receives no YouTube id or media
-- origin/path. The same-origin signaling broker derives court playback from
-- the HttpOnly assignment instead.
create or replace function public.community_match_json(p_match_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', match.id,
    'eventId', match.event_id,
    'courtId', court.id,
    'courtNumber', court.court_number,
    'courtName', court.display_name,
    'teamAName', coalesce(match.team_a, 'Team A'),
    'teamBName', coalesce(match.team_b, 'Team B'),
    'matchNumber', match.match_number,
    'roundName', match.round_name,
    'format', match.format
  )
  from public.matches match
  join public.score_states score on score.match_id = match.id
  join public.courts court
    on court.id = score.court_id and court.event_id = match.event_id
  where match.id = p_match_id
  limit 1;
$$;

revoke all on function public.community_reserve_media_session(text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.community_activate_media_session(text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.community_fail_media_session(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.community_touch_media_sessions(text, integer) from public, anon, authenticated;
revoke all on function public.community_claim_media_session_close(text, uuid, text, uuid, integer) from public, anon, authenticated;
revoke all on function public.community_request_media_session_close(text) from public, anon, authenticated;
revoke all on function public.community_claim_media_cleanup(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.community_finish_media_cleanup(uuid, text, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.community_close_media_on_assignment_change() from public, anon, authenticated;
revoke all on function public.community_record_playback_evidence(text, text, bigint, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.community_record_playback_evidence(text, text, bigint, text, text, jsonb) from service_role;
revoke all on function public.community_submit_scorer_command_with_evidence(text, text, bigint, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.community_create_trusted_assignment(uuid, uuid, uuid, text, text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.community_claim_trusted_designated_assignment(uuid, uuid, uuid, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.community_scorer_command_recorded(text, text) from public, anon, authenticated;
revoke all on function public.community_prune_media_history(integer) from public, anon, authenticated;
revoke all on function public.community_match_json(uuid) from public, anon, authenticated;

grant execute on function public.community_reserve_media_session(text, integer, integer, integer) to service_role;
grant execute on function public.community_activate_media_session(text, uuid, text, text) to service_role;
grant execute on function public.community_fail_media_session(uuid, text, text, text) to service_role;
grant execute on function public.community_touch_media_sessions(text, integer) to service_role;
grant execute on function public.community_claim_media_session_close(text, uuid, text, uuid, integer) to service_role;
grant execute on function public.community_request_media_session_close(text) to service_role;
grant execute on function public.community_claim_media_cleanup(text, uuid, integer, integer) to service_role;
grant execute on function public.community_finish_media_cleanup(uuid, text, uuid, boolean, text) to service_role;
grant execute on function public.community_close_media_on_assignment_change() to service_role;
grant execute on function public.community_submit_scorer_command_with_evidence(text, text, bigint, jsonb, jsonb) to service_role;
grant execute on function public.community_create_trusted_assignment(uuid, uuid, uuid, text, text, text, text, integer, text, text) to service_role;
grant execute on function public.community_claim_trusted_designated_assignment(uuid, uuid, uuid, text, text, integer, text, text) to service_role;
grant execute on function public.community_scorer_command_recorded(text, text) to service_role;
grant execute on function public.community_prune_media_history(integer) to service_role;
grant execute on function public.community_match_json(uuid) to service_role;
