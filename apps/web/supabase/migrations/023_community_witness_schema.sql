-- 023: Hard-cut the scorekeeping domain to one match-centric canonical state
-- plus immutable community evidence. Browser clients never access these
-- tables directly; all access is through allowlisted server APIs and the
-- transactional RPCs installed by migration 024.

create extension if not exists "pgcrypto";

-- The Community Witness assignment/grant model fully replaces legacy instant
-- claims, shadow scores, and reusable court bearer tokens.
alter table if exists public.youtube_chat_messages
  drop column if exists matched_claim_id;

drop table if exists public.scorer_shadow_states cascade;
drop table if exists public.scorer_session_events cascade;
drop table if exists public.scorer_claims cascade;
drop table if exists public.scorer_sessions cascade;

alter table public.courts
  drop column if exists scorer_token,
  drop column if exists scorer_token_hash,
  drop column if exists scorer_token_created_at,
  drop column if exists scorer_token_rotated_at,
  drop column if exists scorer_token_revoked_at;

-- score_states is the one canonical score projection. Remove the legacy
-- court-scoped identity before adding the match-scoped invariant.
update public.score_states score
set match_id = court.current_match_id
from public.courts court
where score.court_id = court.id
  and score.match_id is null
  and court.current_match_id is not null;

-- A score without a match cannot be made authoritative. The hard cut revokes
-- those legacy orphan projections rather than carrying an ambiguous row.
delete from public.score_states where match_id is null;

-- One live match cannot truthfully belong to multiple courts. Fail with an
-- actionable diagnostic before selecting a canonical score survivor.
do $$
declare
  duplicated_match uuid;
begin
  select current_match_id into duplicated_match
  from public.courts
  where current_match_id is not null
  group by current_match_id
  having count(*) > 1
  order by current_match_id
  limit 1;
  if duplicated_match is not null then
    raise exception 'community witness migration found match % assigned to multiple current courts', duplicated_match
      using errcode = '23514',
        hint = 'Resolve duplicate courts.current_match_id ownership before applying migration 023.';
  end if;
end;
$$;

-- Legacy retries could leave more than one projection for a match after the
-- match-id backfill. Keep one deterministic survivor: the row on the court
-- currently owning that match, then the newest row, then the UUID tie-break.
with ranked_scores as (
  select score.id,
    row_number() over (
      partition by score.match_id
      order by
        exists (
          select 1 from public.courts court
          where court.id = score.court_id
            and court.current_match_id = score.match_id
        ) desc,
        score.updated_at desc nulls last,
        score.created_at desc nulls last,
        score.id
    ) as survivor_rank
  from public.score_states score
)
delete from public.score_states score
using ranked_scores ranked
where score.id = ranked.id and ranked.survivor_rank > 1;

-- Canonical API/UI labels replace the legacy lowercase `prematch` default.
update public.score_states set status = case
  when lower(btrim(status)) in ('final', 'finished', 'completed', 'complete') then 'Final'
  when lower(btrim(status)) in ('set complete', 'set_complete') then 'Set Complete'
  when lower(btrim(status)) in ('prematch', 'pre-match', 'pre match', 'scheduled', 'waiting', 'idle', '') then 'Pre-Match'
  else 'In Progress'
end;

alter table public.score_states
  drop constraint if exists score_states_court_id_key;

drop index if exists public.score_states_court_id_key;

alter table public.score_states
  alter column match_id set not null,
  alter column court_id set not null,
  add column if not exists revision bigint not null default 0,
  add column if not exists authority_epoch bigint not null default 1,
  add column if not exists authority_mode text not null default 'PAUSED_DISPUTE',
  add column if not exists state_hash text not null default '',
  add column if not exists current_rally_number integer not null default 0;

alter table public.score_states
  alter column status set default 'Pre-Match';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'score_states_revision_nonnegative'
  ) then
    alter table public.score_states
      add constraint score_states_revision_nonnegative check (revision >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'score_states_authority_epoch_positive'
  ) then
    alter table public.score_states
      add constraint score_states_authority_epoch_positive check (authority_epoch > 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'score_states_authority_mode_check'
  ) then
    alter table public.score_states
      add constraint score_states_authority_mode_check check (authority_mode in (
        'ADMIN_LOCKED',
        'PROVIDER_PRIMARY',
        'DESIGNATED_PRIMARY',
        'VERIFIED_CONSENSUS',
        'PAUSED_DISPUTE'
      ));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'score_states_current_rally_nonnegative'
  ) then
    alter table public.score_states
      add constraint score_states_current_rally_nonnegative check (current_rally_number >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'score_states_canonical_status_check'
  ) then
    alter table public.score_states
      add constraint score_states_canonical_status_check
      check (status in ('Pre-Match', 'In Progress', 'Set Complete', 'Final'));
  end if;
end $$;

-- Preserve existing source intent while failing closed for legacy manual rows.
update public.score_states
set authority_mode = case
    when source = 'override' then 'ADMIN_LOCKED'
    when source = 'api' then 'PROVIDER_PRIMARY'
    else 'PAUSED_DISPUTE'
  end,
  state_hash = encode(digest(
    jsonb_build_object(
      'matchId', match_id,
      'teamAScore', team_a_score,
      'teamBScore', team_b_score,
      'teamASets', team_a_sets,
      'teamBSets', team_b_sets,
      'currentSet', current_set,
      'setScores', set_scores,
      'servingTeam', serving_team,
      'timeouts', timeouts,
      'status', status,
      'currentRallyNumber', current_rally_number
    )::text,
    'sha256'
  ), 'hex');

create unique index if not exists score_states_match_unique_idx
  on public.score_states(match_id);
create index if not exists score_states_court_current_idx
  on public.score_states(court_id, updated_at desc);

-- Legacy matches were unique by API URL, so two linked rows may share a
-- provider external id. Do not silently delete a match with court/score FKs;
-- stop before installing the new provider identity invariant.
do $$
declare
  duplicate_event_id uuid;
  duplicate_external_id text;
begin
  select event_id, external_match_id
  into duplicate_event_id, duplicate_external_id
  from public.matches
  where external_match_id is not null
  group by event_id, external_match_id
  having count(*) > 1
  order by event_id, external_match_id
  limit 1;
  if duplicate_event_id is not null then
    raise exception 'community witness migration found duplicate external match id % in event %',
      duplicate_external_id, duplicate_event_id
      using errcode = '23514',
        hint = 'Merge or re-key the duplicate linked matches before applying migration 023.';
  end if;
end;
$$;

create unique index if not exists matches_event_external_match_unique_idx
  on public.matches(event_id, external_match_id);

create table if not exists public.community_join_grants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  action_id uuid not null unique,
  token_hash text not null unique,
  grant_role text not null check (grant_role in ('OBSERVER', 'VERIFIED_WITNESS', 'DESIGNATED_SCORER')),
  label text,
  max_uses integer not null default 1 check (max_uses between 1 and 1000),
  use_count integer not null default 0 check (use_count >= 0),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);

create index if not exists community_join_grants_scope_idx
  on public.community_join_grants(event_id, court_id, match_id, expires_at)
  where revoked_at is null;

create table if not exists public.community_assignments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  grant_id uuid references public.community_join_grants(id) on delete set null,
  session_token_hash text not null unique,
  device_token_hash text check (device_token_hash is null or char_length(device_token_hash) = 64),
  display_name text not null check (char_length(display_name) between 1 and 80),
  role text not null check (role in ('OBSERVER', 'VERIFIED_WITNESS', 'DESIGNATED_SCORER')),
  trust_tier text not null check (trust_tier in ('REMOTE', 'COURTSIDE', 'VERIFIED_COURTSIDE')),
  status text not null default 'ACTIVE'
    check (status in ('ACTIVE', 'RELEASED', 'REVOKED', 'EXPIRED', 'MATCH_ENDED')),
  authority_epoch bigint not null default 1 check (authority_epoch > 0),
  lease_expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  released_at timestamptz,
  revoked_at timestamptz,
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists community_assignments_one_designated_idx
  on public.community_assignments(match_id)
  where role = 'DESIGNATED_SCORER' and status = 'ACTIVE';
create index if not exists community_assignments_match_active_idx
  on public.community_assignments(match_id, status, role, lease_expires_at);
create unique index if not exists community_assignments_one_active_device_idx
  on public.community_assignments(match_id, device_token_hash)
  where status = 'ACTIVE' and device_token_hash is not null;
create index if not exists community_assignments_observer_capacity_idx
  on public.community_assignments(match_id, lease_expires_at)
  where status = 'ACTIVE' and role in ('OBSERVER', 'VERIFIED_WITNESS');

create table if not exists public.community_admission_counters (
  scope_type text not null check (scope_type in ('DEVICE', 'IP')),
  scope_hash text not null check (char_length(scope_hash) = 64),
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope_type, scope_hash)
);
create index if not exists community_admission_counters_retention_idx
  on public.community_admission_counters(updated_at);

create table if not exists public.canonical_score_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  assignment_id uuid references public.community_assignments(id) on delete set null,
  revision bigint not null check (revision >= 0),
  authority_epoch bigint not null check (authority_epoch > 0),
  authority_mode text not null check (authority_mode in (
    'ADMIN_LOCKED', 'PROVIDER_PRIMARY', 'DESIGNATED_PRIMARY',
    'VERIFIED_CONSENSUS', 'PAUSED_DISPUTE'
  )),
  command_id text not null check (char_length(command_id) between 8 and 128),
  command_type text not null check (command_type in (
    'ADD_POINT', 'REMOVE_POINT', 'CORRECT_SCORE', 'COMPLETE_SET',
    'COMPLETE_MATCH', 'SET_SERVE', 'AUTHORITY_CHANGE',
    'ASSIGNMENT_PROMOTED', 'ASSIGNMENT_RELEASED', 'MATCH_TRANSITION',
    'REVIEW_DISMISSED'
  )),
  team_side text check (team_side is null or team_side in ('A', 'B')),
  actor_type text not null check (actor_type in ('COMMUNITY_SCORER', 'ADMIN', 'PROVIDER', 'SYSTEM', 'CONSENSUS')),
  actor_label text,
  previous_state jsonb not null,
  next_state jsonb not null,
  state_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (match_id, revision, authority_epoch),
  unique (command_id)
);

create index if not exists canonical_score_events_match_idx
  on public.canonical_score_events(match_id, revision desc, authority_epoch desc);

create table if not exists public.canonical_score_outbox (
  id uuid primary key default gen_random_uuid(),
  canonical_event_id uuid not null unique references public.canonical_score_events(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  revision bigint not null check (revision > 0),
  score_payload jsonb not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claimed_by text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, revision)
);

create index if not exists canonical_score_outbox_retry_idx
  on public.canonical_score_outbox(status, next_attempt_at, created_at)
  where status in ('PENDING', 'FAILED');

create table if not exists public.rally_observations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  assignment_id uuid not null references public.community_assignments(id) on delete cascade,
  client_action_id text not null check (char_length(client_action_id) between 8 and 128),
  base_revision bigint not null check (base_revision >= 0),
  rally_number integer not null check (rally_number >= 0),
  action_type text not null check (action_type in ('ADD_POINT', 'REMOVE_POINT')),
  team_side text not null check (team_side in ('A', 'B')),
  playback_timestamp_ms bigint check (playback_timestamp_ms is null or playback_timestamp_ms >= 0),
  device_sequence bigint check (device_sequence is null or device_sequence >= 0),
  received_at timestamptz not null default now(),
  unique (assignment_id, client_action_id)
);

create index if not exists rally_observations_resolution_idx
  on public.rally_observations(match_id, base_revision, rally_number, received_at);
create unique index if not exists rally_observations_one_vote_per_revision_idx
  on public.rally_observations(assignment_id, base_revision);

create table if not exists public.rally_resolutions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  rally_number integer not null check (rally_number >= 0),
  canonical_event_id uuid references public.canonical_score_events(id) on delete set null,
  status text not null check (status in ('UNOBSERVED', 'CONFIRMED', 'DISPUTED', 'CORRECTED', 'VOIDED')),
  action_type text not null check (action_type in ('ADD_POINT', 'REMOVE_POINT')),
  team_side text not null check (team_side in ('A', 'B')),
  witness_count integer not null default 0 check (witness_count >= 0),
  confirmed_count integer not null default 0 check (confirmed_count >= 0),
  differing_count integer not null default 0 check (differing_count >= 0),
  resolved_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (match_id, rally_number)
);

create index if not exists rally_resolutions_recent_idx
  on public.rally_resolutions(match_id, rally_number desc);

create table if not exists public.contribution_receipts (
  id uuid primary key default gen_random_uuid(),
  observation_id uuid unique references public.rally_observations(id) on delete cascade,
  canonical_event_id uuid unique references public.canonical_score_events(id) on delete cascade,
  assignment_id uuid not null references public.community_assignments(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  rally_number integer not null check (rally_number >= 0),
  status text not null check (status in (
    'RECORDED', 'CONFIRMED', 'TRIGGERED_REVIEW',
    'CONTRIBUTED_TO_CORRECTION', 'DIFFERED', 'LATE'
  )),
  message_code text not null,
  canonical_revision bigint,
  -- Current status answers "how did this rally resolve?" while this timestamp
  -- permanently answers "did this contribution ever open a score check?".
  -- Keeping those facts separate prevents a later dismissal/correction from
  -- erasing truthful engagement credit.
  review_triggered_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'TRIGGERED_REVIEW' or review_triggered_at is not null),
  check ((observation_id is null) <> (canonical_event_id is null))
);

create index if not exists contribution_receipts_assignment_idx
  on public.contribution_receipts(assignment_id, created_at desc);

create table if not exists public.score_disputes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  rally_number integer not null check (rally_number >= 0),
  base_revision bigint not null check (base_revision >= 0),
  canonical_event_id uuid references public.canonical_score_events(id) on delete set null,
  status text not null default 'OPEN'
    check (status in ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED')),
  expected_action_type text not null check (expected_action_type in ('ADD_POINT', 'REMOVE_POINT')),
  expected_team_side text not null check (expected_team_side in ('A', 'B')),
  differing_count integer not null default 0 check (differing_count >= 0),
  eligible_vote_count integer not null default 0 check (eligible_vote_count >= 0),
  proposal_vote_count integer not null default 0 check (proposal_vote_count >= 0),
  proposal_eligible boolean not null default false,
  vote_breakdown jsonb not null default '[]'::jsonb
    check (jsonb_typeof(vote_breakdown) = 'array'),
  resolution text,
  opened_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists score_disputes_one_open_per_rally_idx
  on public.score_disputes(match_id, rally_number)
  where status in ('OPEN', 'ACKNOWLEDGED');
create index if not exists score_disputes_open_idx
  on public.score_disputes(event_id, court_id, status, opened_at desc);

comment on table public.community_assignments is
  'Match/event/court scoped community sessions. A raw session token is never stored.';
comment on table public.canonical_score_events is
  'Immutable ordered canonical score and authority ledger.';
comment on table public.rally_observations is
  'Immutable community evidence. Observations never mutate score_states directly.';
comment on table public.canonical_score_outbox is
  'Retryable projection work created in the same transaction as each canonical score revision.';
