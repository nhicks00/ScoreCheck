-- 024: Private transactional boundary for Community Witness scoring.

-- Fail closed at the database boundary. Browser roles have no direct table or
-- function access; Next server routes use service_role and return safe DTOs.
alter table public.score_states enable row level security;
alter table public.community_join_grants enable row level security;
alter table public.community_assignments enable row level security;
alter table public.community_admission_counters enable row level security;
alter table public.canonical_score_events enable row level security;
alter table public.canonical_score_outbox enable row level security;
alter table public.rally_observations enable row level security;
alter table public.rally_resolutions enable row level security;
alter table public.contribution_receipts enable row level security;
alter table public.score_disputes enable row level security;

revoke all on table public.score_states from anon, authenticated;
revoke all on table public.community_join_grants from anon, authenticated;
revoke all on table public.community_assignments from anon, authenticated;
revoke all on table public.community_admission_counters from anon, authenticated;
revoke all on table public.canonical_score_events from anon, authenticated;
revoke all on table public.canonical_score_outbox from anon, authenticated;
revoke all on table public.rally_observations from anon, authenticated;
revoke all on table public.rally_resolutions from anon, authenticated;
revoke all on table public.contribution_receipts from anon, authenticated;
revoke all on table public.score_disputes from anon, authenticated;

grant all on table public.score_states to service_role;
grant all on table public.community_join_grants to service_role;
grant all on table public.community_assignments to service_role;
grant all on table public.community_admission_counters to service_role;
grant all on table public.canonical_score_events to service_role;
grant all on table public.canonical_score_outbox to service_role;
grant all on table public.rally_observations to service_role;
grant all on table public.rally_resolutions to service_role;
grant all on table public.contribution_receipts to service_role;
grant all on table public.score_disputes to service_role;

create or replace function public.community_reject_immutable_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception '% is immutable', tg_table_name using errcode = '55000';
end;
$$;

drop trigger if exists canonical_score_events_immutable on public.canonical_score_events;
create trigger canonical_score_events_immutable
before update or delete on public.canonical_score_events
for each row execute function public.community_reject_immutable_mutation();

drop trigger if exists rally_observations_immutable on public.rally_observations;
create trigger rally_observations_immutable
before update or delete on public.rally_observations
for each row execute function public.community_reject_immutable_mutation();

create or replace function public.community_guard_receipt_review_history()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'TRIGGERED_REVIEW' and new.review_triggered_at is null then
      raise exception 'review-triggered receipt requires immutable trigger time'
        using errcode = '23514';
    elsif new.status <> 'TRIGGERED_REVIEW' and new.review_triggered_at is not null then
      raise exception 'review trigger time can only begin with a review transition'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.review_triggered_at is not null
    and new.review_triggered_at is distinct from old.review_triggered_at then
    raise exception 'receipt review trigger history is immutable'
      using errcode = '23514';
  end if;
  if old.review_triggered_at is null then
    if new.status = 'TRIGGERED_REVIEW' and new.review_triggered_at is null then
      raise exception 'review-triggered receipt requires immutable trigger time'
        using errcode = '23514';
    elsif new.review_triggered_at is not null and new.status <> 'TRIGGERED_REVIEW' then
      raise exception 'review trigger time can only begin with a review transition'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists contribution_receipts_review_history_guard on public.contribution_receipts;
create trigger contribution_receipts_review_history_guard
before insert or update on public.contribution_receipts
for each row execute function public.community_guard_receipt_review_history();

create or replace function public.community_normalize_score_state(p_state jsonb)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  normalized jsonb;
  status_value text;
  serving_value text;
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'score state must be an object' using errcode = '22023';
  end if;

  if (p_state - array[
    'teamAScore', 'teamBScore', 'teamASets', 'teamBSets', 'currentSet',
    'setScores', 'servingTeam', 'timeouts', 'status', 'currentRallyNumber'
  ]) <> '{}'::jsonb then
    raise exception 'score state contains unsupported fields' using errcode = '22023';
  end if;

  if not (p_state ?& array[
    'teamAScore', 'teamBScore', 'teamASets', 'teamBSets', 'currentSet',
    'setScores', 'status'
  ]) then
    raise exception 'score state is missing required fields' using errcode = '22023';
  end if;

  if jsonb_typeof(p_state->'setScores') <> 'array' then
    raise exception 'setScores must be an array' using errcode = '22023';
  end if;
  if p_state ? 'timeouts' and jsonb_typeof(p_state->'timeouts') <> 'object' then
    raise exception 'timeouts must be an object' using errcode = '22023';
  end if;

  status_value := p_state->>'status';
  if status_value not in ('Pre-Match', 'In Progress', 'Set Complete', 'Final') then
    raise exception 'invalid score status' using errcode = '22023';
  end if;
  serving_value := nullif(p_state->>'servingTeam', '');
  if serving_value is not null and serving_value not in ('A', 'B') then
    raise exception 'invalid serving team' using errcode = '22023';
  end if;

  normalized := jsonb_build_object(
    'teamAScore', (p_state->>'teamAScore')::integer,
    'teamBScore', (p_state->>'teamBScore')::integer,
    'teamASets', (p_state->>'teamASets')::integer,
    'teamBSets', (p_state->>'teamBSets')::integer,
    'currentSet', (p_state->>'currentSet')::integer,
    'setScores', p_state->'setScores',
    'servingTeam', to_jsonb(serving_value),
    'timeouts', coalesce(p_state->'timeouts', '{}'::jsonb),
    'status', status_value,
    'currentRallyNumber', coalesce((p_state->>'currentRallyNumber')::integer, 0)
  );

  if (normalized->>'teamAScore')::integer < 0
    or (normalized->>'teamBScore')::integer < 0
    or (normalized->>'teamASets')::integer < 0
    or (normalized->>'teamBSets')::integer < 0
    or (normalized->>'currentSet')::integer < 1
    or (normalized->>'currentRallyNumber')::integer < 0 then
    raise exception 'score values are outside the allowed range' using errcode = '22023';
  end if;
  if (normalized->>'teamAScore')::integer > 999
    or (normalized->>'teamBScore')::integer > 999
    or (normalized->>'teamASets')::integer > 99
    or (normalized->>'teamBSets')::integer > 99
    or (normalized->>'currentSet')::integer > 99 then
    raise exception 'score values exceed safety ceilings' using errcode = '22023';
  end if;
  return normalized;
exception
  when invalid_text_representation then
    raise exception 'score fields must be integers' using errcode = '22023';
end;
$$;

create or replace function public.community_score_state_json(p_score public.score_states)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'revision', p_score.revision,
    'authorityEpoch', p_score.authority_epoch,
    'authorityMode', p_score.authority_mode,
    'stateHash', p_score.state_hash,
    'teamAScore', p_score.team_a_score,
    'teamBScore', p_score.team_b_score,
    'teamASets', p_score.team_a_sets,
    'teamBSets', p_score.team_b_sets,
    'currentSet', p_score.current_set,
    'setScores', p_score.set_scores,
    'servingTeam', p_score.serving_team,
    'timeouts', p_score.timeouts,
    'status', p_score.status,
    'currentRallyNumber', p_score.current_rally_number,
    'updatedAt', p_score.updated_at
  );
$$;

create or replace function public.community_score_input_json(p_score public.score_states)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'teamAScore', p_score.team_a_score,
    'teamBScore', p_score.team_b_score,
    'teamASets', p_score.team_a_sets,
    'teamBSets', p_score.team_b_sets,
    'currentSet', p_score.current_set,
    'setScores', p_score.set_scores,
    'servingTeam', p_score.serving_team,
    'timeouts', p_score.timeouts,
    'status', p_score.status,
    'currentRallyNumber', p_score.current_rally_number
  );
$$;

create or replace function public.community_score_hash(p_match_id uuid, p_state jsonb)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select encode(extensions.digest(
    jsonb_build_object('matchId', p_match_id, 'state', public.community_normalize_score_state(p_state))::text,
    'sha256'
  ), 'hex');
$$;

-- Migration 023 can only compute a provisional hash before the canonical hash
-- function exists. Re-backfill every carried score projection with the exact
-- runtime algorithm before any new canonical event is accepted.
update public.score_states score set
  state_hash = public.community_score_hash(
    score.match_id,
    public.community_score_input_json(score)
  );

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
    'youtubeVideoId', nullif(btrim(court.youtube_video_id), ''),
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

create or replace function public.community_assignment_json(p_assignment public.community_assignments)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', p_assignment.id,
    'eventId', p_assignment.event_id,
    'courtId', p_assignment.court_id,
    'matchId', p_assignment.match_id,
    'displayName', p_assignment.display_name,
    'role', p_assignment.role,
    'trustTier', p_assignment.trust_tier,
    'status', p_assignment.status,
    'authorityEpoch', p_assignment.authority_epoch,
    'leaseExpiresAt', p_assignment.lease_expires_at
  );
$$;

create or replace function public.community_receipt_message(p_status text, p_rally_number integer)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select case p_status
    when 'RECORDED' then format('Recorded for Rally %s.', p_rally_number)
    when 'CONFIRMED' then format('You helped confirm Rally %s.', p_rally_number)
    when 'TRIGGERED_REVIEW' then format('Your call helped open a score check for Rally %s.', p_rally_number)
    when 'CONTRIBUTED_TO_CORRECTION' then format('Your call contributed to the correction for Rally %s.', p_rally_number)
    when 'DIFFERED' then format('Rally %s resolved differently.', p_rally_number)
    when 'LATE' then format('Rally %s was already closed when your call arrived.', p_rally_number)
    else format('Contribution recorded for Rally %s.', p_rally_number)
  end;
$$;

create or replace function public.community_receipt_json(p_receipt public.contribution_receipts)
returns jsonb
language sql
stable
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', p_receipt.id,
    'rallyNumber', p_receipt.rally_number,
    'status', p_receipt.status,
    'message', public.community_receipt_message(p_receipt.status, p_receipt.rally_number),
    'canonicalRevision', p_receipt.canonical_revision,
    'resolvedAt', p_receipt.resolved_at
  );
$$;

create or replace function public.community_engagement_json(
  p_match_id uuid,
  p_assignment_id uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  score_row public.score_states%rowtype;
  latest_receipt public.contribution_receipts%rowtype;
  witness_count integer;
  confirmed_together integer;
  recent_rallies jsonb;
  contributions_recorded integer := 0;
  confirmed_calls integer := 0;
  review_triggers integer := 0;
  corrections_helped integer := 0;
  has_contributed_to_current_revision boolean := false;
begin
  select * into score_row from public.score_states where match_id = p_match_id;
  select count(*)::integer into witness_count
  from public.community_assignments
  where match_id = p_match_id
    and role in ('OBSERVER', 'VERIFIED_WITNESS')
    and status = 'ACTIVE'
    and lease_expires_at > statement_timestamp();
  select count(*)::integer into confirmed_together
  from public.rally_resolutions
  where match_id = p_match_id and status in ('CONFIRMED', 'CORRECTED');
  select coalesce(jsonb_agg(item order by (item->>'rallyNumber')::integer), '[]'::jsonb)
  into recent_rallies
  from (
    select jsonb_build_object('rallyNumber', rally_number, 'status', status) item
    from public.rally_resolutions
    where match_id = p_match_id
    order by rally_number desc
    limit 8
  ) recent;
  if p_assignment_id is not null then
    select * into latest_receipt
    from public.contribution_receipts
    where assignment_id = p_assignment_id
    order by created_at desc
    limit 1;
    select count(*)::integer,
      count(*) filter (where status = 'CONFIRMED')::integer,
      count(*) filter (where review_triggered_at is not null)::integer,
      count(*) filter (where status = 'CONTRIBUTED_TO_CORRECTION')::integer
    into contributions_recorded, confirmed_calls, review_triggers, corrections_helped
    from public.contribution_receipts
    where assignment_id = p_assignment_id;
    select exists (
      select 1
      from public.rally_observations observation
      where observation.assignment_id = p_assignment_id
        and observation.match_id = p_match_id
        and observation.base_revision = score_row.revision
    ) into has_contributed_to_current_revision;
  end if;
  return jsonb_build_object(
    'currentRallyNumber', coalesce(score_row.current_rally_number, 0),
    'witnessCount', coalesce(witness_count, 0),
    'confirmedTogether', coalesce(confirmed_together, 0),
    'hasContributedToCurrentRevision', has_contributed_to_current_revision,
    'recentRallies', coalesce(recent_rallies, '[]'::jsonb),
    'latestReceipt', case
      when latest_receipt.id is null then null
      else public.community_receipt_json(latest_receipt)
    end,
    'personalSummary', jsonb_build_object(
      'contributionsRecorded', coalesce(contributions_recorded, 0),
      'confirmedCalls', coalesce(confirmed_calls, 0),
      'reviewTriggers', coalesce(review_triggers, 0),
      'correctionsHelped', coalesce(corrections_helped, 0)
    )
  );
end;
$$;

create or replace function public.community_session_response(
  p_assignment_id uuid,
  p_duplicate boolean default false,
  p_event_id uuid default null,
  p_outbox_id uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
  score_row public.score_states%rowtype;
  receipt_row public.contribution_receipts%rowtype;
begin
  select * into assignment_row from public.community_assignments where id = p_assignment_id;
  if assignment_row.id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  select * into score_row from public.score_states where match_id = assignment_row.match_id;
  select * into receipt_row
  from public.contribution_receipts
  where assignment_id = assignment_row.id
  order by created_at desc
  limit 1;
  return jsonb_build_object(
    'ok', true,
    'duplicate', p_duplicate,
    'eventId', p_event_id,
    'outboxId', p_outbox_id,
    'assignment', public.community_assignment_json(assignment_row),
    'match', public.community_match_json(assignment_row.match_id),
    'score', public.community_score_state_json(score_row),
    'receipt', case when receipt_row.id is null then null else public.community_receipt_json(receipt_row) end,
    'community', public.community_engagement_json(assignment_row.match_id, assignment_row.id)
  );
end;
$$;

create or replace function public.community_fallback_mode(p_match_id uuid)
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select case
    when exists (
      select 1 from public.community_assignments
      where match_id = p_match_id and role = 'DESIGNATED_SCORER'
        and status = 'ACTIVE' and lease_expires_at > clock_timestamp()
    ) then 'DESIGNATED_PRIMARY'
    when (
      select count(*) from public.community_assignments
      where match_id = p_match_id and role = 'VERIFIED_WITNESS'
        and trust_tier = 'VERIFIED_COURTSIDE' and status = 'ACTIVE'
        and lease_expires_at > clock_timestamp()
    ) >= 3 then 'VERIFIED_CONSENSUS'
    else 'PAUSED_DISPUTE'
  end;
$$;

-- Reconcile lease-backed authority before any session/status read reports
-- coverage. Admin and provider authority are not lease-backed; community
-- authority is downgraded atomically when its designated scorer or verified
-- witness quorum is no longer live.
create or replace function public.community_reconcile_authority(
  p_match_id uuid,
  p_reason text default 'lease_reconciliation'
)
returns public.score_states
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  score_row public.score_states%rowtype;
  court_row public.courts%rowtype;
  previous_mode text;
  target_mode text;
  verified_count integer := 0;
  new_epoch bigint;
  expired_count integer := 0;
begin
  if p_match_id is null then return null; end if;
  if p_reason is null or char_length(btrim(p_reason)) < 1 or char_length(p_reason) > 120 then
    raise exception 'authority reconciliation reason is invalid' using errcode = '22023';
  end if;

  -- Healthy reads take no row lock. Only a lease-backed authority that is
  -- observably missing its live owner/quorum enters the locked recheck path.
  select * into score_row
  from public.score_states
  where match_id = p_match_id;
  if score_row.id is null then return null; end if;
  if score_row.authority_mode in ('ADMIN_LOCKED', 'PROVIDER_PRIMARY', 'PAUSED_DISPUTE') then
    return score_row;
  end if;
  if score_row.authority_mode = 'DESIGNATED_PRIMARY' and exists (
    select 1
    from public.community_assignments assignment
    where assignment.match_id = p_match_id
      and assignment.role = 'DESIGNATED_SCORER'
      and assignment.status = 'ACTIVE'
      and assignment.lease_expires_at > clock_timestamp()
  ) then return score_row;
  elsif score_row.authority_mode = 'VERIFIED_CONSENSUS' then
    select count(*)::integer into verified_count
    from public.community_assignments assignment
    where assignment.match_id = p_match_id
      and assignment.role = 'VERIFIED_WITNESS'
      and assignment.trust_tier = 'VERIFIED_COURTSIDE'
      and assignment.status = 'ACTIVE'
      and assignment.lease_expires_at > clock_timestamp();
    if verified_count >= 3 then return score_row; end if;
  end if;

  -- Match the global court -> score -> assignment lock order, then recheck all
  -- lease predicates so a concurrent heartbeat/admission cannot be downgraded.
  select * into court_row
  from public.courts where id = score_row.court_id for update;
  select * into score_row
  from public.score_states where match_id = p_match_id for update;
  if score_row.id is null
    or court_row.id is null
    or court_row.current_match_id is distinct from p_match_id
    or score_row.authority_mode in ('ADMIN_LOCKED', 'PROVIDER_PRIMARY', 'PAUSED_DISPUTE') then
    return score_row;
  end if;

  if score_row.authority_mode = 'DESIGNATED_PRIMARY' and exists (
    select 1 from public.community_assignments assignment
    where assignment.match_id = p_match_id
      and assignment.role = 'DESIGNATED_SCORER'
      and assignment.status = 'ACTIVE'
      and assignment.lease_expires_at > clock_timestamp()
  ) then return score_row;
  elsif score_row.authority_mode = 'VERIFIED_CONSENSUS' then
    select count(*)::integer into verified_count
    from public.community_assignments assignment
    where assignment.match_id = p_match_id
      and assignment.role = 'VERIFIED_WITNESS'
      and assignment.trust_tier = 'VERIFIED_COURTSIDE'
      and assignment.status = 'ACTIVE'
      and assignment.lease_expires_at > clock_timestamp();
    if verified_count >= 3 then return score_row; end if;
  end if;

  update public.community_assignments set
    status = 'EXPIRED',
    ended_at = coalesce(ended_at, clock_timestamp()),
    updated_at = clock_timestamp()
  where match_id = p_match_id
    and status = 'ACTIVE'
    and lease_expires_at <= clock_timestamp();
  get diagnostics expired_count = row_count;

  previous_mode := score_row.authority_mode;
  target_mode := public.community_fallback_mode(p_match_id);
  if target_mode = previous_mode then return score_row; end if;

  new_epoch := score_row.authority_epoch + 1;
  update public.score_states set
    authority_epoch = new_epoch,
    authority_mode = target_mode,
    updated_at = clock_timestamp()
  where id = score_row.id
  returning * into score_row;

  -- Every still-live participant receives the new epoch in its next DTO. Only
  -- designated commands enforce epoch ownership, but keeping all sessions in
  -- sync prevents stale authority indicators after a fallback.
  update public.community_assignments set
    authority_epoch = new_epoch,
    updated_at = clock_timestamp()
  where match_id = p_match_id
    and status = 'ACTIVE'
    and lease_expires_at > clock_timestamp();

  insert into public.canonical_score_events (
    event_id, court_id, match_id, revision, authority_epoch, authority_mode,
    command_id, command_type, actor_type, actor_label,
    previous_state, next_state, state_hash, metadata
  ) values (
    (select court.event_id from public.courts court where court.id = score_row.court_id),
    score_row.court_id, p_match_id, score_row.revision, new_epoch, target_mode,
    'reconcile:' || p_match_id::text || ':' || new_epoch::text,
    'AUTHORITY_CHANGE', 'SYSTEM', 'Community lease reconciliation',
    public.community_score_input_json(score_row),
    public.community_score_input_json(score_row),
    score_row.state_hash,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'previousAuthorityMode', previous_mode,
      'selectedAuthorityMode', target_mode,
      'expiredAssignments', expired_count
    )
  );
  return score_row;
end;
$$;

create or replace function public.community_reduce_score_action(
  p_previous jsonb,
  p_action jsonb,
  p_format jsonb
)
returns jsonb
language plpgsql
stable
set search_path = pg_catalog, public
as $$
declare
  previous jsonb := public.community_normalize_score_state(p_previous);
  next_state jsonb;
  action_type text := p_action->>'type';
  team_side text := p_action->>'team';
  current_set integer;
  team_a_score integer;
  team_b_score integer;
  team_a_sets integer;
  team_b_sets integer;
  best_of integer := coalesce((p_format->>'bestOf')::integer, 3);
  sets_to_win integer;
  target integer;
  cap_value integer;
  win_by_two boolean := coalesce((p_format->>'winByTwo')::boolean, true);
  high_score integer;
  low_score integer;
  set_scores jsonb;
  latest_set jsonb;
  latest_set_number integer;
  latest_set_winner text;
begin
  sets_to_win := coalesce((p_format->>'setsToWin')::integer, (best_of + 1) / 2);
  if p_action is null or jsonb_typeof(p_action) <> 'object' then
    raise exception 'score action must be an object' using errcode = '22023';
  end if;
  if action_type not in ('ADD_POINT', 'REMOVE_POINT', 'CORRECT_SCORE', 'COMPLETE_SET', 'COMPLETE_MATCH', 'SET_SERVE') then
    raise exception 'unsupported score action' using errcode = '22023';
  end if;
  if previous->>'status' = 'Final' and action_type not in ('CORRECT_SCORE', 'REMOVE_POINT') then
    raise exception 'match is already final' using errcode = '23514';
  end if;

  if action_type = 'CORRECT_SCORE' then
    if (p_action - array['type', 'score']) <> '{}'::jsonb or not (p_action ? 'score') then
      raise exception 'invalid CORRECT_SCORE payload' using errcode = '22023';
    end if;
    return public.community_normalize_score_state(p_action->'score');
  end if;

  if action_type in ('ADD_POINT', 'REMOVE_POINT', 'SET_SERVE') then
    if (p_action - array['type', 'team']) <> '{}'::jsonb or team_side not in ('A', 'B') then
      raise exception 'score action requires team A or B' using errcode = '22023';
    end if;
  elsif (p_action - 'type') <> '{}'::jsonb then
    raise exception 'score action contains unsupported fields' using errcode = '22023';
  end if;

  current_set := (previous->>'currentSet')::integer;
  team_a_score := (previous->>'teamAScore')::integer;
  team_b_score := (previous->>'teamBScore')::integer;
  team_a_sets := (previous->>'teamASets')::integer;
  team_b_sets := (previous->>'teamBSets')::integer;
  next_state := previous;

  if action_type = 'ADD_POINT' then
    if team_side = 'A' then team_a_score := team_a_score + 1;
    else team_b_score := team_b_score + 1;
    end if;
    target := coalesce(
      (p_format->'pointsPerSet'->>(current_set - 1))::integer,
      case when current_set >= best_of then 15 else 21 end
    );
    cap_value := nullif((p_format->>'cap')::integer, 0);
    high_score := greatest(team_a_score, team_b_score);
    low_score := least(team_a_score, team_b_score);
    if team_a_score <> team_b_score
      and ((cap_value is not null and high_score >= cap_value)
        or (high_score >= target and (not win_by_two or high_score - low_score >= 2))) then
      if team_a_score > team_b_score then team_a_sets := team_a_sets + 1;
      else team_b_sets := team_b_sets + 1;
      end if;
      select coalesce(jsonb_agg(value order by (value->>'setNumber')::integer), '[]'::jsonb)
      into set_scores
      from (
        select value from jsonb_array_elements(previous->'setScores') value
        where (value->>'setNumber')::integer <> current_set
        union all
        select jsonb_build_object(
          'setNumber', current_set,
          'teamAScore', team_a_score,
          'teamBScore', team_b_score,
          'isComplete', true
        )
      ) completed;
      if team_a_sets >= sets_to_win or team_b_sets >= sets_to_win or current_set >= best_of then
        next_state := next_state || jsonb_build_object(
          'teamAScore', team_a_score, 'teamBScore', team_b_score,
          'teamASets', team_a_sets, 'teamBSets', team_b_sets,
          'setScores', set_scores, 'status', 'Final',
          'currentRallyNumber', (previous->>'currentRallyNumber')::integer + 1
        );
      else
        next_state := next_state || jsonb_build_object(
          'teamAScore', 0, 'teamBScore', 0,
          'teamASets', team_a_sets, 'teamBSets', team_b_sets,
          'currentSet', current_set + 1, 'setScores', set_scores,
          'servingTeam', null, 'status', 'In Progress',
          'currentRallyNumber', (previous->>'currentRallyNumber')::integer + 1
        );
      end if;
    else
      next_state := next_state || jsonb_build_object(
        'teamAScore', team_a_score,
        'teamBScore', team_b_score,
        'status', 'In Progress',
        'currentRallyNumber', (previous->>'currentRallyNumber')::integer + 1
      );
    end if;
  elsif action_type = 'REMOVE_POINT' then
    if previous->>'status' = 'Final' or (
      team_a_score = 0 and team_b_score = 0
      and jsonb_array_length(previous->'setScores') > 0
    ) then
      select value into latest_set
      from jsonb_array_elements(previous->'setScores') value
      order by (value->>'setNumber')::integer desc
      limit 1;
      if latest_set is null then
        raise exception 'completed set history is unavailable for correction' using errcode = '23514';
      end if;
      latest_set_number := (latest_set->>'setNumber')::integer;
      team_a_score := (latest_set->>'teamAScore')::integer;
      team_b_score := (latest_set->>'teamBScore')::integer;
      latest_set_winner := case when team_a_score > team_b_score then 'A' else 'B' end;
      if team_side = 'A' and team_a_score <= 0 then
        raise exception 'team A score is already zero' using errcode = '23514';
      elsif team_side = 'B' and team_b_score <= 0 then
        raise exception 'team B score is already zero' using errcode = '23514';
      end if;
      if team_side = 'A' then team_a_score := team_a_score - 1;
      else team_b_score := team_b_score - 1;
      end if;
      target := coalesce(
        (p_format->'pointsPerSet'->>(latest_set_number - 1))::integer,
        case when latest_set_number >= best_of then 15 else 21 end
      );
      cap_value := nullif((p_format->>'cap')::integer, 0);
      high_score := greatest(team_a_score, team_b_score);
      low_score := least(team_a_score, team_b_score);
      select coalesce(jsonb_agg(value order by (value->>'setNumber')::integer), '[]'::jsonb)
      into set_scores
      from (
        select value from jsonb_array_elements(previous->'setScores') value
        where (value->>'setNumber')::integer <> latest_set_number
        union all
        select jsonb_build_object(
          'setNumber', latest_set_number,
          'teamAScore', team_a_score,
          'teamBScore', team_b_score,
          'isComplete', true
        )
      ) corrected;
      if team_a_score <> team_b_score and (
        (cap_value is not null and high_score >= cap_value)
        or (high_score >= target and (not win_by_two or high_score - low_score >= 2))
      ) then
        -- The correction did not invalidate the completed set. Preserve its
        -- set credit and the already-advanced next set/final phase.
        next_state := next_state || jsonb_build_object('setScores', set_scores);
        if previous->>'status' = 'Final' then
          next_state := next_state || jsonb_build_object(
            'teamAScore', team_a_score, 'teamBScore', team_b_score
          );
        end if;
        return public.community_normalize_score_state(next_state);
      end if;
      if latest_set_winner = 'A' then team_a_sets := greatest(team_a_sets - 1, 0);
      else team_b_sets := greatest(team_b_sets - 1, 0);
      end if;
      select coalesce(jsonb_agg(value order by (value->>'setNumber')::integer), '[]'::jsonb)
      into set_scores
      from jsonb_array_elements(previous->'setScores') value
      where (value->>'setNumber')::integer <> latest_set_number;
      return public.community_normalize_score_state(next_state || jsonb_build_object(
        'teamAScore', team_a_score, 'teamBScore', team_b_score,
        'teamASets', team_a_sets, 'teamBSets', team_b_sets,
        'currentSet', latest_set_number, 'setScores', set_scores,
        'servingTeam', null, 'status', 'In Progress'
      ));
    end if;
    if team_side = 'A' and team_a_score <= 0 then
      raise exception 'team A score is already zero' using errcode = '23514';
    elsif team_side = 'B' and team_b_score <= 0 then
      raise exception 'team B score is already zero' using errcode = '23514';
    end if;
    if team_side = 'A' then team_a_score := team_a_score - 1;
    else team_b_score := team_b_score - 1;
    end if;
    next_state := next_state || jsonb_build_object(
      'teamAScore', team_a_score,
      'teamBScore', team_b_score,
      'status', case
        when team_a_score + team_b_score + team_a_sets + team_b_sets = 0 then 'Pre-Match'
        else 'In Progress'
      end,
      'teamASets', team_a_sets,
      'teamBSets', team_b_sets,
      'currentSet', coalesce(latest_set_number, current_set),
      'setScores', coalesce(set_scores, previous->'setScores')
    );
  elsif action_type = 'SET_SERVE' then
    next_state := next_state || jsonb_build_object('servingTeam', team_side);
  elsif action_type = 'COMPLETE_SET' then
    if team_a_score = team_b_score then
      raise exception 'set needs a winner' using errcode = '23514';
    end if;
    target := coalesce(
      (p_format->'pointsPerSet'->>(current_set - 1))::integer,
      case when current_set >= best_of then 15 else 21 end
    );
    cap_value := nullif((p_format->>'cap')::integer, 0);
    high_score := greatest(team_a_score, team_b_score);
    low_score := least(team_a_score, team_b_score);
    if not ((cap_value is not null and high_score >= cap_value)
      or (high_score >= target and (not win_by_two or high_score - low_score >= 2))) then
      raise exception 'set completion requirements are not satisfied' using errcode = '23514';
    end if;
    if team_a_score > team_b_score then team_a_sets := team_a_sets + 1;
    else team_b_sets := team_b_sets + 1;
    end if;
    select coalesce(jsonb_agg(value order by (value->>'setNumber')::integer), '[]'::jsonb)
    into set_scores
    from (
      select value from jsonb_array_elements(previous->'setScores') value
      where (value->>'setNumber')::integer <> current_set
      union all
      select jsonb_build_object(
        'setNumber', current_set,
        'teamAScore', team_a_score,
        'teamBScore', team_b_score,
        'isComplete', true
      )
    ) completed;
    if team_a_sets >= sets_to_win or team_b_sets >= sets_to_win or current_set >= best_of then
      next_state := next_state || jsonb_build_object(
        'teamASets', team_a_sets, 'teamBSets', team_b_sets,
        'setScores', set_scores, 'status', 'Final'
      );
    else
      next_state := next_state || jsonb_build_object(
        'teamAScore', 0, 'teamBScore', 0,
        'teamASets', team_a_sets, 'teamBSets', team_b_sets,
        'currentSet', current_set + 1, 'setScores', set_scores,
        'servingTeam', null, 'status', 'In Progress'
      );
    end if;
  elsif action_type = 'COMPLETE_MATCH' then
    if team_a_sets < sets_to_win and team_b_sets < sets_to_win then
      raise exception 'match completion requirements are not satisfied' using errcode = '23514';
    end if;
    next_state := next_state || jsonb_build_object('status', 'Final');
  end if;
  return public.community_normalize_score_state(next_state);
exception
  when invalid_text_representation then
    raise exception 'match format contains invalid numeric fields' using errcode = '22023';
end;
$$;

create or replace function public.community_commit_locked_score(
  p_match_id uuid,
  p_assignment_id uuid,
  p_action_id text,
  p_command_type text,
  p_team_side text,
  p_actor_type text,
  p_actor_label text,
  p_expected_revision bigint,
  p_expected_authority_epoch bigint,
  p_authority_mode text,
  p_next_state jsonb,
  p_projection_metadata jsonb default '{}'::jsonb,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  score_row public.score_states%rowtype;
  duplicate_event public.canonical_score_events%rowtype;
  canonical_event public.canonical_score_events%rowtype;
  outbox_row public.canonical_score_outbox%rowtype;
  normalized jsonb;
  previous jsonb;
  new_revision bigint;
  new_epoch bigint;
  computed_hash text;
  target_rally_number integer;
  observed_count integer := 0;
  matching_count integer := 0;
  differing_count integer := 0;
  verified_observed_count integer := 0;
  verified_matching_count integer := 0;
  verified_differing_count integer := 0;
  verified_vote_breakdown jsonb := '[]'::jsonb;
  resolution_status text;
  projection_metadata jsonb := coalesce(p_projection_metadata, '{}'::jsonb);
  scope_event_id uuid;
  desired_source text;
  desired_source_available boolean;
  desired_source_priority text;
  desired_pending_scores jsonb;
  desired_stale boolean;
  desired_message text;
begin
  if p_action_id is null or char_length(p_action_id) < 8 or char_length(p_action_id) > 128 then
    raise exception 'action id is invalid' using errcode = '22023';
  end if;
  select * into score_row from public.score_states where match_id = p_match_id for update;
  if score_row.id is null then
    raise exception 'canonical score not found' using errcode = 'P0002';
  end if;
  -- Recheck idempotency after the per-match lock. Concurrent retries now
  -- serialize and the second caller returns the first committed result.
  select * into duplicate_event
  from public.canonical_score_events where command_id = p_action_id;
  if duplicate_event.id is not null then
    if duplicate_event.match_id <> p_match_id
      or duplicate_event.assignment_id is distinct from p_assignment_id then
      raise exception 'action id was already used in another scope' using errcode = '23505';
    end if;
    if p_assignment_id is null then
      return jsonb_build_object(
        'ok', true, 'duplicate', true, 'eventId', duplicate_event.id,
        'outboxId', (select id from public.canonical_score_outbox where canonical_event_id = duplicate_event.id),
        'match', public.community_match_json(p_match_id),
        'score', public.community_score_state_json(score_row),
        'community', public.community_engagement_json(p_match_id, null)
      );
    end if;
    return public.community_session_response(p_assignment_id, true, duplicate_event.id,
      (select id from public.canonical_score_outbox where canonical_event_id = duplicate_event.id));
  end if;
  select court.event_id into scope_event_id
  from public.courts court
  join public.matches match on match.id = p_match_id and match.event_id = court.event_id
  where court.id = score_row.court_id;
  if scope_event_id is null then
    raise exception 'score scope does not match its court and event' using errcode = '23514';
  end if;
  if p_expected_revision is not null and score_row.revision <> p_expected_revision then
    raise exception 'score revision conflict: expected %, current %', p_expected_revision, score_row.revision
      using errcode = '40001';
  end if;
  if p_expected_authority_epoch is not null and score_row.authority_epoch <> p_expected_authority_epoch then
    raise exception 'authority epoch conflict' using errcode = '40001';
  end if;
  if p_authority_mode not in (
    'ADMIN_LOCKED', 'PROVIDER_PRIMARY', 'DESIGNATED_PRIMARY',
    'VERIFIED_CONSENSUS', 'PAUSED_DISPUTE'
  ) then
    raise exception 'authority mode is invalid' using errcode = '22023';
  end if;
  if (projection_metadata - array[
    'source', 'sourceAvailable', 'sourcePriority', 'sourcePendingScores',
    'stale', 'message', 'lastApiPollAt', 'lastScoreChangeAt'
  ]) <> '{}'::jsonb then
    raise exception 'projection metadata contains unsupported fields' using errcode = '22023';
  end if;

  previous := public.community_score_input_json(score_row);
  normalized := public.community_normalize_score_state(p_next_state);
  desired_source := coalesce(projection_metadata->>'source', case
    when p_actor_type = 'ADMIN' then 'override'
    when p_actor_type = 'PROVIDER' then 'api'
    else 'manual'
  end);
  desired_source_available := coalesce((projection_metadata->>'sourceAvailable')::boolean, p_actor_type = 'PROVIDER');
  desired_source_priority := coalesce(projection_metadata->>'sourcePriority', case
    when p_actor_type = 'ADMIN' then 'override'
    when p_actor_type = 'PROVIDER' then 'primary'
    else 'fallback'
  end);
  desired_pending_scores := coalesce(projection_metadata->'sourcePendingScores', '[]'::jsonb);
  desired_stale := coalesce((projection_metadata->>'stale')::boolean, false);
  desired_message := case when projection_metadata ? 'message' then projection_metadata->>'message' else null end;

  -- Freshness-only provider observations are operational heartbeats, not
  -- canonical score revisions. They may refresh last_api_poll_at in place.
  if normalized = previous
    and coalesce((p_metadata->>'forceRevision')::boolean, false) is not true
    and score_row.authority_mode = p_authority_mode
    and score_row.source = desired_source
    and score_row.source_available = desired_source_available
    and score_row.source_priority = desired_source_priority
    and score_row.source_pending_scores = desired_pending_scores
    and score_row.stale = desired_stale
    and score_row.message is not distinct from desired_message then
    if projection_metadata ? 'lastApiPollAt' then
      update public.score_states set
        last_api_poll_at = (projection_metadata->>'lastApiPollAt')::timestamptz
      where id = score_row.id
      returning * into score_row;
    end if;
    if p_assignment_id is null then
      return jsonb_build_object(
        'ok', true, 'duplicate', false, 'noOp', true,
        'eventId', null, 'outboxId', null,
        'match', public.community_match_json(p_match_id),
        'score', public.community_score_state_json(score_row),
        'community', public.community_engagement_json(p_match_id, null)
      );
    end if;
    return public.community_session_response(p_assignment_id, false, null, null)
      || jsonb_build_object('noOp', true);
  end if;
  new_revision := score_row.revision + 1;
  new_epoch := score_row.authority_epoch + case when score_row.authority_mode <> p_authority_mode then 1 else 0 end;
  computed_hash := public.community_score_hash(p_match_id, normalized);

  update public.score_states set
    team_a_score = (normalized->>'teamAScore')::integer,
    team_b_score = (normalized->>'teamBScore')::integer,
    team_a_sets = (normalized->>'teamASets')::integer,
    team_b_sets = (normalized->>'teamBSets')::integer,
    current_set = (normalized->>'currentSet')::integer,
    set_scores = normalized->'setScores',
    serving_team = nullif(normalized->>'servingTeam', ''),
    timeouts = normalized->'timeouts',
    status = normalized->>'status',
    current_rally_number = (normalized->>'currentRallyNumber')::integer,
    revision = new_revision,
    authority_epoch = new_epoch,
    authority_mode = p_authority_mode,
    state_hash = computed_hash,
    source = desired_source,
    source_available = desired_source_available,
    source_priority = desired_source_priority,
    source_pending_scores = desired_pending_scores,
    stale = desired_stale,
    message = desired_message,
    last_api_poll_at = case
      when projection_metadata ? 'lastApiPollAt' then (projection_metadata->>'lastApiPollAt')::timestamptz
      else score_row.last_api_poll_at
    end,
    last_score_change_at = case
      when projection_metadata ? 'lastScoreChangeAt' then (projection_metadata->>'lastScoreChangeAt')::timestamptz
      else clock_timestamp()
    end,
    updated_at = clock_timestamp()
  where id = score_row.id
  returning * into score_row;

  insert into public.canonical_score_events (
    event_id, court_id, match_id, assignment_id, revision, authority_epoch,
    authority_mode, command_id, command_type, team_side, actor_type,
    actor_label, previous_state, next_state, state_hash, metadata
  ) values (
    scope_event_id,
    score_row.court_id,
    score_row.match_id,
    p_assignment_id,
    new_revision,
    new_epoch,
    p_authority_mode,
    p_action_id,
    p_command_type,
    p_team_side,
    p_actor_type,
    p_actor_label,
    previous,
    normalized,
    computed_hash,
    coalesce(p_metadata, '{}'::jsonb)
  ) returning * into canonical_event;

  insert into public.canonical_score_outbox (
    canonical_event_id, event_id, court_id, match_id, revision, score_payload
  ) values (
    canonical_event.id,
    canonical_event.event_id,
    score_row.court_id,
    p_match_id,
    new_revision,
    public.community_score_state_json(score_row)
  ) returning * into outbox_row;

  if p_command_type in ('ADD_POINT', 'REMOVE_POINT') and p_team_side in ('A', 'B') then
    target_rally_number := (normalized->>'currentRallyNumber')::integer;
    select count(*)::integer,
      count(*) filter (where action_type = p_command_type and team_side = p_team_side)::integer
    into observed_count, matching_count
    from public.rally_observations
    where match_id = p_match_id and base_revision = score_row.revision - 1;
    differing_count := observed_count - matching_count;
    select count(*)::integer,
      count(*) filter (
        where observation.action_type = p_command_type
          and observation.team_side = p_team_side
      )::integer
    into verified_observed_count, verified_matching_count
    from public.rally_observations observation
    join public.community_assignments witness on witness.id = observation.assignment_id
    where observation.match_id = p_match_id
      and observation.base_revision = score_row.revision - 1
      and witness.role = 'VERIFIED_WITNESS'
      and witness.trust_tier = 'VERIFIED_COURTSIDE'
      and witness.status = 'ACTIVE'
      and witness.lease_expires_at > clock_timestamp();
    verified_differing_count := verified_observed_count - verified_matching_count;
    select coalesce(jsonb_agg(jsonb_build_object(
      'actionType', vote.action_type,
      'teamSide', vote.team_side,
      'count', vote.vote_count
    ) order by vote.vote_count desc, vote.action_type, vote.team_side), '[]'::jsonb)
    into verified_vote_breakdown
    from (
      select observation.action_type, observation.team_side, count(*)::integer as vote_count
      from public.rally_observations observation
      join public.community_assignments witness on witness.id = observation.assignment_id
      where observation.match_id = p_match_id
        and observation.base_revision = score_row.revision - 1
        and witness.role = 'VERIFIED_WITNESS'
        and witness.trust_tier = 'VERIFIED_COURTSIDE'
        and witness.status = 'ACTIVE'
        and witness.lease_expires_at > clock_timestamp()
      group by observation.action_type, observation.team_side
    ) vote;
    resolution_status := case
      when observed_count = 0 then 'UNOBSERVED'
      when verified_differing_count >= 2 then 'DISPUTED'
      when p_command_type = 'REMOVE_POINT' then 'CORRECTED'
      else 'CONFIRMED'
    end;
    insert into public.rally_resolutions (
      event_id, court_id, match_id, rally_number, canonical_event_id, status,
      action_type, team_side, witness_count, confirmed_count, differing_count
    ) values (
      canonical_event.event_id, score_row.court_id, p_match_id, target_rally_number,
      canonical_event.id, resolution_status, p_command_type, p_team_side,
      observed_count, matching_count, differing_count
    )
    on conflict (match_id, rally_number) do update set
      canonical_event_id = excluded.canonical_event_id,
      status = case
        when excluded.status = 'DISPUTED' then 'DISPUTED'
        when excluded.action_type = 'REMOVE_POINT' then 'CORRECTED'
        else excluded.status
      end,
      action_type = excluded.action_type,
      team_side = excluded.team_side,
      witness_count = excluded.witness_count,
      confirmed_count = excluded.confirmed_count,
      differing_count = excluded.differing_count,
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp();

    update public.contribution_receipts receipt set
      status = case
        when observation.action_type = p_command_type and observation.team_side = p_team_side then 'CONFIRMED'
        when verified_differing_count >= 2
          and witness.role = 'VERIFIED_WITNESS'
          and witness.trust_tier = 'VERIFIED_COURTSIDE'
          and witness.status = 'ACTIVE'
          and witness.lease_expires_at > clock_timestamp() then 'TRIGGERED_REVIEW'
        else 'DIFFERED'
      end,
      message_code = case
        when observation.action_type = p_command_type and observation.team_side = p_team_side then 'MATCHED_CANONICAL'
        when verified_differing_count >= 2
          and witness.role = 'VERIFIED_WITNESS'
          and witness.trust_tier = 'VERIFIED_COURTSIDE'
          and witness.status = 'ACTIVE'
          and witness.lease_expires_at > clock_timestamp() then 'OPENED_SCORE_CHECK'
        else 'RESOLVED_DIFFERENTLY'
      end,
      canonical_revision = new_revision,
      review_triggered_at = case
        when observation.action_type <> p_command_type
          or observation.team_side <> p_team_side then case
            when verified_differing_count >= 2
              and witness.role = 'VERIFIED_WITNESS'
              and witness.trust_tier = 'VERIFIED_COURTSIDE'
              and witness.status = 'ACTIVE'
              and witness.lease_expires_at > clock_timestamp()
              then coalesce(receipt.review_triggered_at, clock_timestamp())
            else receipt.review_triggered_at
          end
        else receipt.review_triggered_at
      end,
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp()
    from public.rally_observations observation
    join public.community_assignments witness on witness.id = observation.assignment_id
    where receipt.observation_id = observation.id
      and observation.match_id = p_match_id
      and observation.base_revision = new_revision - 1;

    -- Anonymous/remote disagreement remains visible in receipts but cannot
    -- flood the admin queue. A post-canonical review requires two independent,
    -- currently-live verified courtside dissenters (one vote per assignment
    -- and base revision is enforced by the observation unique index).
    if verified_differing_count >= 2 then
      insert into public.score_disputes (
        event_id, court_id, match_id, rally_number, base_revision,
        canonical_event_id, expected_action_type, expected_team_side, differing_count,
        eligible_vote_count, proposal_vote_count, proposal_eligible, vote_breakdown
      ) values (
        canonical_event.event_id, score_row.court_id, p_match_id, target_rally_number,
        new_revision - 1, canonical_event.id, p_command_type, p_team_side, verified_differing_count,
        verified_observed_count, verified_matching_count, false, verified_vote_breakdown
      )
      on conflict (match_id, rally_number) where status in ('OPEN', 'ACKNOWLEDGED')
      do nothing;
    end if;
  end if;

  -- Full-state corrections and provider jumps may not map safely to one rally
  -- choice. Close every superseded pending receipt instead of implying that it
  -- is still waiting or inventing confirmation credit.
  update public.contribution_receipts receipt set
    status = 'LATE',
    message_code = 'SCORE_CHANGED_BEFORE_COMPARISON',
    canonical_revision = new_revision,
    resolved_at = clock_timestamp(),
    updated_at = clock_timestamp()
  from public.rally_observations observation
  where receipt.observation_id = observation.id
    and receipt.status = 'RECORDED'
    and observation.match_id = p_match_id
    and observation.base_revision = new_revision - 1;

  if p_assignment_id is not null then
    target_rally_number := (normalized->>'currentRallyNumber')::integer;
    insert into public.contribution_receipts (
      canonical_event_id, assignment_id, event_id, court_id, match_id,
      rally_number, status, message_code, canonical_revision, resolved_at
    ) values (
      canonical_event.id, p_assignment_id, canonical_event.event_id,
      score_row.court_id, p_match_id, target_rally_number, 'CONFIRMED',
      'DESIGNATED_CANONICAL', new_revision, clock_timestamp()
    );
    return public.community_session_response(p_assignment_id, false, canonical_event.id, outbox_row.id);
  end if;
  return jsonb_build_object(
    'ok', true, 'duplicate', false, 'eventId', canonical_event.id,
    'outboxId', outbox_row.id,
    'match', public.community_match_json(p_match_id),
    'score', public.community_score_state_json(score_row),
    'community', public.community_engagement_json(p_match_id, null)
  );
end;
$$;

create or replace function public.community_ensure_score_projection(
  p_event_id uuid,
  p_court_id uuid,
  p_match_id uuid,
  p_authority_mode text default 'PAUSED_DISPUTE'
)
returns public.score_states
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  score_row public.score_states%rowtype;
  initial_state jsonb := jsonb_build_object(
    'teamAScore', 0, 'teamBScore', 0,
    'teamASets', 0, 'teamBSets', 0,
    'currentSet', 1, 'setScores', '[]'::jsonb,
    'servingTeam', null, 'timeouts', '{}'::jsonb,
    'status', 'Pre-Match', 'currentRallyNumber', 0
  );
begin
  if not exists (
    select 1 from public.matches
    where id = p_match_id and event_id = p_event_id
  ) or not exists (
    select 1 from public.courts
    where id = p_court_id and event_id = p_event_id
  ) then
    raise exception 'event, court, and match scope is invalid' using errcode = '23514';
  end if;
  insert into public.score_states (
    court_id, match_id,
    team_a_score, team_b_score, team_a_sets, team_b_sets,
    current_set, set_scores, serving_team, timeouts, status,
    source, stale, source_available, source_priority, source_pending_scores,
    revision, authority_epoch, authority_mode, state_hash,
    current_rally_number, last_score_change_at, updated_at
  ) values (
    p_court_id, p_match_id,
    0, 0, 0, 0, 1, '[]'::jsonb, null, '{}'::jsonb, 'Pre-Match',
    'manual', false, false, 'fallback', '[]'::jsonb,
    0, 1, p_authority_mode, public.community_score_hash(p_match_id, initial_state),
    0, clock_timestamp(), clock_timestamp()
  )
  on conflict (match_id) do nothing;
  select * into score_row from public.score_states where match_id = p_match_id for update;
  if score_row.court_id <> p_court_id then
    -- Bracket refresh may remap a match after its old court has already
    -- transitioned away. Rebind only when the old court no longer claims the
    -- match and the new court currently does.
    if exists (
      select 1 from public.courts
      where id = score_row.court_id and current_match_id = p_match_id
    ) or not exists (
      select 1 from public.courts
      where id = p_court_id and current_match_id = p_match_id
    ) then
      raise exception 'match score is assigned to another active court' using errcode = '23514';
    end if;
    update public.score_states set court_id = p_court_id, updated_at = clock_timestamp()
    where id = score_row.id returning * into score_row;
  end if;
  return score_row;
end;
$$;

create or replace function public.community_consume_admission_quota(
  p_device_token_hash text,
  p_ip_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  device_attempts integer;
  ip_attempts integer;
  allowed boolean;
  denial_reason text := null;
  window_cutoff timestamptz := clock_timestamp() - interval '10 minutes';
begin
  if p_device_token_hash is null or char_length(p_device_token_hash) <> 64
    or p_ip_hash is null or char_length(p_ip_hash) <> 64 then
    raise exception 'admission identity hashes are invalid' using errcode = '22023';
  end if;
  -- Check the shared network backstop first. Once blocked, rotated device
  -- cookies cannot create unlimited counter rows during the same window.
  insert into public.community_admission_counters (
    scope_type, scope_hash, window_started_at, attempt_count, updated_at
  ) values (
    'IP', p_ip_hash, clock_timestamp(), 1, clock_timestamp()
  )
  on conflict (scope_type, scope_hash) do update set
    window_started_at = case
      when community_admission_counters.window_started_at <= window_cutoff then clock_timestamp()
      else community_admission_counters.window_started_at
    end,
    attempt_count = case
      when community_admission_counters.window_started_at <= window_cutoff then 1
      else least(community_admission_counters.attempt_count + 1, 2147483647)
    end,
    updated_at = clock_timestamp()
  returning attempt_count into ip_attempts;
  -- Deliberately generous for tournament/venue NAT. Device identity is the
  -- primary distributed admission boundary; IP is only a flood backstop.

  -- Pseudonymous device/IP hashes have a one-hour retention target. Cleanup
  -- is indexed, bounded, and amortized to the first/each 64th request in an IP
  -- window so admission never performs an unbounded sweep or lock storm.
  if ip_attempts = 1 or mod(ip_attempts, 64) = 0 then
    delete from public.community_admission_counters expired
    where expired.ctid in (
      select candidate.ctid
      from public.community_admission_counters candidate
      where candidate.updated_at < clock_timestamp() - interval '1 hour'
      order by candidate.updated_at
      limit 200
      for update skip locked
    );
  end if;

  if ip_attempts > 6000 then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'NETWORK_RATE_LIMIT',
      'deviceAttempts', null,
      'ipAttempts', ip_attempts
    );
  end if;

  insert into public.community_admission_counters (
    scope_type, scope_hash, window_started_at, attempt_count, updated_at
  ) values (
    'DEVICE', p_device_token_hash, clock_timestamp(), 1, clock_timestamp()
  )
  on conflict (scope_type, scope_hash) do update set
    window_started_at = case
      when community_admission_counters.window_started_at <= window_cutoff then clock_timestamp()
      else community_admission_counters.window_started_at
    end,
    attempt_count = case
      when community_admission_counters.window_started_at <= window_cutoff then 1
      else least(community_admission_counters.attempt_count + 1, 2147483647)
    end,
    updated_at = clock_timestamp()
  returning attempt_count into device_attempts;
  allowed := device_attempts <= 30;
  if not allowed then denial_reason := 'DEVICE_RATE_LIMIT'; end if;
  -- This function intentionally returns a decision instead of raising when a
  -- quota is exceeded. Supabase commits each RPC separately; returning lets
  -- the over-limit increment persist so repeated rejected attempts cannot
  -- roll the counter back. The application must call this RPC before join.
  return jsonb_build_object(
    'allowed', allowed,
    'reason', denial_reason,
    'deviceAttempts', device_attempts,
    'ipAttempts', ip_attempts
  );
end;
$$;

create or replace function public.community_join_assignment(
  p_event_slug text,
  p_court_number integer,
  p_display_name text,
  p_session_token_hash text,
  p_device_token_hash text,
  p_requested_role text default 'OBSERVER',
  p_participation_mode text default 'REMOTE',
  p_grant_token_hash text default null,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  event_row public.events%rowtype;
  court_row public.courts%rowtype;
  grant_row public.community_join_grants%rowtype;
  assignment_row public.community_assignments%rowtype;
  existing_assignment public.community_assignments%rowtype;
  score_row public.score_states%rowtype;
  assigned_role text := 'OBSERVER';
  assigned_trust_tier text := 'REMOTE';
  new_epoch bigint;
  authority_event public.canonical_score_events%rowtype;
  verified_count integer := 0;
  active_observer_count integer := 0;
  reused_assignment boolean := false;
  becoming_designated boolean := false;
  consumes_observer_slot boolean := false;
  device_was_revoked boolean := false;
begin
  if p_event_slug is null or btrim(p_event_slug) = ''
    or p_court_number < 1 or p_court_number > 64 then
    raise exception 'event and court are required' using errcode = '22023';
  end if;
  if p_display_name is null or char_length(btrim(p_display_name)) < 1
    or char_length(btrim(p_display_name)) > 80 then
    raise exception 'display name is invalid' using errcode = '22023';
  end if;
  if p_session_token_hash is null or char_length(p_session_token_hash) <> 64 then
    raise exception 'session token hash is invalid' using errcode = '22023';
  end if;
  if p_device_token_hash is null or char_length(p_device_token_hash) <> 64 then
    raise exception 'admission device hash is invalid' using errcode = '22023';
  end if;
  if p_requested_role not in ('OBSERVER', 'DESIGNATED_SCORER') then
    raise exception 'requested role is invalid' using errcode = '22023';
  end if;
  if p_participation_mode not in ('REMOTE', 'COURTSIDE') then
    raise exception 'participation mode is invalid' using errcode = '22023';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'lease duration is invalid' using errcode = '22023';
  end if;
  select * into event_row
  from public.events
  where slug = btrim(p_event_slug)
    and is_active = true
    and lower(status) <> 'completed'
  for share;
  if event_row.id is null then
    raise exception 'active event not found' using errcode = 'P0002';
  end if;
  select * into court_row
  from public.courts
  where event_id = event_row.id and court_number = p_court_number
  for update;
  if court_row.id is null or court_row.current_match_id is null then
    raise exception 'court has no active match' using errcode = 'P0002';
  end if;
  if not coalesce(court_row.scoring_open, false) or court_row.frozen then
    raise exception 'community scoring is closed' using errcode = '55000';
  end if;

  score_row := public.community_ensure_score_projection(
    event_row.id, court_row.id, court_row.current_match_id, 'PAUSED_DISPUTE'
  );

  update public.community_assignments set
    status = 'EXPIRED',
    ended_at = coalesce(ended_at, clock_timestamp()),
    updated_at = clock_timestamp()
  where match_id = court_row.current_match_id
    and status = 'ACTIVE' and lease_expires_at <= clock_timestamp();
  score_row := public.community_reconcile_authority(
    court_row.current_match_id, 'join_expiry_reconciliation'
  );

  select exists (
    select 1 from public.community_assignments
    where match_id = court_row.current_match_id
      and device_token_hash = p_device_token_hash
      and status = 'REVOKED'
  ) into device_was_revoked;

  -- Device identity deduplicates admission but never carries trust. Reuse the
  -- live or most recent non-revoked row; the current grant below determines
  -- its newly admitted role. REVOKED/MATCH_ENDED rows remain immutable audit
  -- evidence and are never resurrected.
  select * into existing_assignment
  from public.community_assignments
  where match_id = court_row.current_match_id
    and device_token_hash = p_device_token_hash
    and status in ('ACTIVE', 'EXPIRED', 'RELEASED')
  order by
    (status = 'ACTIVE' and lease_expires_at > clock_timestamp()) desc,
    updated_at desc,
    created_at desc
  limit 1
  for update;
  reused_assignment := existing_assignment.id is not null
    and existing_assignment.status = 'ACTIVE'
    and existing_assignment.lease_expires_at > clock_timestamp();

  if p_grant_token_hash is not null then
    select * into grant_row
    from public.community_join_grants
    where token_hash = p_grant_token_hash
    for update;
    if grant_row.id is null
      or grant_row.event_id <> event_row.id
      or grant_row.court_id <> court_row.id
      or grant_row.match_id <> court_row.current_match_id
      or grant_row.revoked_at is not null
      or grant_row.expires_at <= clock_timestamp()
      or (grant_row.use_count >= grant_row.max_uses
        and existing_assignment.grant_id is distinct from grant_row.id) then
      raise exception 'join grant is invalid or expired' using errcode = '28000';
    end if;
    if p_requested_role = 'DESIGNATED_SCORER' and grant_row.grant_role <> 'DESIGNATED_SCORER' then
      raise exception 'join grant cannot designate a scorer' using errcode = '28000';
    end if;
    if p_requested_role = 'DESIGNATED_SCORER' then
      assigned_role := 'DESIGNATED_SCORER';
      assigned_trust_tier := 'VERIFIED_COURTSIDE';
    elsif grant_row.grant_role in ('VERIFIED_WITNESS', 'DESIGNATED_SCORER') then
      assigned_role := 'VERIFIED_WITNESS';
      assigned_trust_tier := 'VERIFIED_COURTSIDE';
    end if;
    if existing_assignment.grant_id is distinct from grant_row.id then
      update public.community_join_grants
      set use_count = use_count + 1
      where id = grant_row.id;
    end if;
  elsif p_requested_role = 'DESIGNATED_SCORER' then
    raise exception 'designated scorer requires a join grant' using errcode = '28000';
  end if;

  if device_was_revoked and grant_row.id is null then
    -- Match-scoped stable-device blocking prevents an ordinary public rejoin.
    -- A fresh organizer grant is an explicit recovery path and creates a new
    -- row, preserving the revoked assignment as immutable moderation evidence.
    raise exception 'this device was revoked for the current match' using errcode = '28000';
  end if;

  consumes_observer_slot := assigned_role in ('OBSERVER', 'VERIFIED_WITNESS')
    and (
      existing_assignment.id is null
      or existing_assignment.status <> 'ACTIVE'
      or existing_assignment.lease_expires_at <= clock_timestamp()
      or existing_assignment.role not in ('OBSERVER', 'VERIFIED_WITNESS')
    );
  if consumes_observer_slot then
    select count(*)::integer into active_observer_count
    from public.community_assignments assignment
    where assignment.match_id = court_row.current_match_id
      and assignment.status = 'ACTIVE'
      and assignment.role in ('OBSERVER', 'VERIFIED_WITNESS')
      and assignment.lease_expires_at > clock_timestamp();
    if active_observer_count >= 500 then
      raise exception 'community observer capacity reached for this match' using errcode = 'P0004';
    end if;
  end if;

  becoming_designated := assigned_role = 'DESIGNATED_SCORER'
    and (
      existing_assignment.id is null
      or existing_assignment.status <> 'ACTIVE'
      or existing_assignment.lease_expires_at <= clock_timestamp()
      or existing_assignment.role <> 'DESIGNATED_SCORER'
    );
  if becoming_designated then
    if score_row.authority_mode in ('ADMIN_LOCKED', 'PROVIDER_PRIMARY') then
      raise exception 'current source authority does not permit a designated scorer' using errcode = '55000';
    end if;
    if exists (
      select 1 from public.community_assignments
      where match_id = court_row.current_match_id
        and role = 'DESIGNATED_SCORER' and status = 'ACTIVE'
        and id is distinct from existing_assignment.id
        and lease_expires_at > clock_timestamp()
    ) then
      raise exception 'this match already has a designated scorer' using errcode = '23505';
    end if;
  end if;

  if existing_assignment.id is not null then
    update public.community_assignments set
      grant_id = coalesce(grant_row.id, grant_id),
      session_token_hash = p_session_token_hash,
      device_token_hash = p_device_token_hash,
      display_name = btrim(p_display_name),
      role = assigned_role,
      trust_tier = assigned_trust_tier,
      status = 'ACTIVE',
      authority_epoch = score_row.authority_epoch,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      last_seen_at = clock_timestamp(),
      released_at = null,
      ended_at = null,
      updated_at = clock_timestamp()
    where id = existing_assignment.id
    returning * into assignment_row;
  else
    insert into public.community_assignments (
      event_id, court_id, match_id, grant_id, session_token_hash,
      device_token_hash,
      display_name, role, trust_tier, authority_epoch,
      lease_expires_at, last_seen_at
    ) values (
      event_row.id, court_row.id, court_row.current_match_id, grant_row.id,
      p_session_token_hash, p_device_token_hash,
      btrim(p_display_name), assigned_role, assigned_trust_tier,
      score_row.authority_epoch, clock_timestamp() + make_interval(secs => p_lease_seconds),
      clock_timestamp()
    ) returning * into assignment_row;
  end if;

  -- Role changes can remove the designated owner or the third verified
  -- witness. Reconcile after re-admission so the score never retains authority
  -- that this device's prior grant used to provide.
  score_row := public.community_reconcile_authority(
    court_row.current_match_id, 'join_role_reconciliation'
  );

  if becoming_designated then
    new_epoch := score_row.authority_epoch + 1;
    update public.community_assignments set
      authority_epoch = new_epoch,
      updated_at = clock_timestamp()
    where id = assignment_row.id
    returning * into assignment_row;
    update public.score_states set
      authority_epoch = new_epoch,
      authority_mode = 'DESIGNATED_PRIMARY',
      updated_at = clock_timestamp()
    where id = score_row.id
    returning * into score_row;
    insert into public.canonical_score_events (
      event_id, court_id, match_id, assignment_id, revision, authority_epoch,
      authority_mode, command_id, command_type, actor_type, actor_label,
      previous_state, next_state, state_hash, metadata
    ) values (
      event_row.id, court_row.id, court_row.current_match_id, assignment_row.id,
      score_row.revision, new_epoch, 'DESIGNATED_PRIMARY',
      'join:' || assignment_row.id::text || ':' || new_epoch::text, 'AUTHORITY_CHANGE',
      'SYSTEM', 'Community admission', public.community_score_input_json(score_row),
      public.community_score_input_json(score_row), score_row.state_hash,
      jsonb_build_object('reason', 'designated_scorer_joined')
    ) returning * into authority_event;
  elsif assigned_role = 'VERIFIED_WITNESS' and score_row.authority_mode = 'PAUSED_DISPUTE' then
    select count(*)::integer into verified_count
    from public.community_assignments witness
    where witness.match_id = court_row.current_match_id
      and witness.role = 'VERIFIED_WITNESS'
      and witness.trust_tier = 'VERIFIED_COURTSIDE'
      and witness.status = 'ACTIVE'
      and witness.lease_expires_at > clock_timestamp();
    if verified_count >= 3 then
      new_epoch := score_row.authority_epoch + 1;
      update public.score_states set authority_epoch = new_epoch,
        authority_mode = 'VERIFIED_CONSENSUS', updated_at = clock_timestamp()
      where id = score_row.id returning * into score_row;
      update public.community_assignments set authority_epoch = new_epoch,
        updated_at = clock_timestamp()
      where match_id = court_row.current_match_id
        and role = 'VERIFIED_WITNESS' and status = 'ACTIVE';
      insert into public.canonical_score_events (
        event_id, court_id, match_id, revision, authority_epoch,
        authority_mode, command_id, command_type, actor_type, actor_label,
        previous_state, next_state, state_hash, metadata
      ) values (
        event_row.id, court_row.id, court_row.current_match_id,
        score_row.revision, new_epoch, 'VERIFIED_CONSENSUS',
        'consensus-ready:' || assignment_row.id::text || ':' || new_epoch::text,
        'AUTHORITY_CHANGE', 'SYSTEM', 'Verified witness quorum',
        public.community_score_input_json(score_row), public.community_score_input_json(score_row),
        score_row.state_hash, jsonb_build_object('verifiedWitnesses', verified_count)
      ) returning * into authority_event;
    end if;
  end if;
  return public.community_session_response(
    assignment_row.id,
    reused_assignment and authority_event.id is null,
    authority_event.id,
    null
  );
end;
$$;

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
  if p_role in ('VERIFIED_WITNESS', 'DESIGNATED_SCORER') and p_trust_tier <> 'VERIFIED_COURTSIDE' then
    raise exception 'trusted scoring roles require verified courtside trust' using errcode = '23514';
  end if;
  select * into court_row from public.courts where id = p_court_id for update;
  if court_row.id is null or court_row.event_id <> p_event_id or court_row.current_match_id <> p_match_id then
    raise exception 'trusted assignment scope is not current' using errcode = '23514';
  end if;
  select * into existing_assignment
  from public.community_assignments
  where session_token_hash = p_session_token_hash;
  if existing_assignment.id is not null then
    return public.community_session_response(existing_assignment.id, true, null, null);
  end if;
  score_row := public.community_ensure_score_projection(p_event_id, p_court_id, p_match_id, 'PAUSED_DISPUTE');
  new_epoch := score_row.authority_epoch;
  if p_role = 'DESIGNATED_SCORER' then
    if score_row.authority_mode in ('ADMIN_LOCKED', 'PROVIDER_PRIMARY') then
      raise exception 'current source authority does not permit designation' using errcode = '55000';
    end if;
    update public.community_assignments set status = 'EXPIRED', updated_at = clock_timestamp()
    where match_id = p_match_id and role = 'DESIGNATED_SCORER'
      and status = 'ACTIVE' and lease_expires_at <= clock_timestamp();
    if exists (
      select 1 from public.community_assignments
      where match_id = p_match_id and role = 'DESIGNATED_SCORER'
        and status = 'ACTIVE' and lease_expires_at > clock_timestamp()
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
    update public.score_states set authority_epoch = new_epoch,
      authority_mode = 'DESIGNATED_PRIMARY', updated_at = clock_timestamp()
    where id = score_row.id returning * into score_row;
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

create or replace function public.community_session_snapshot(p_session_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
begin
  select * into assignment_row
  from public.community_assignments where session_token_hash = p_session_token_hash;
  if assignment_row.id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  perform public.community_reconcile_authority(
    assignment_row.match_id, 'session_snapshot'
  );
  select * into assignment_row
  from public.community_assignments where id = assignment_row.id;
  if assignment_row.status <> 'ACTIVE' or assignment_row.lease_expires_at <= clock_timestamp() then
    raise exception 'community assignment is no longer active' using errcode = 'P0003';
  end if;
  if not exists (
    select 1 from public.courts
    where id = assignment_row.court_id and event_id = assignment_row.event_id
      and current_match_id = assignment_row.match_id
  ) then
    raise exception 'community assignment match has ended' using errcode = 'P0003';
  end if;
  return public.community_session_response(assignment_row.id, false, null, null);
end;
$$;

create or replace function public.community_heartbeat_assignment(
  p_session_token_hash text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
  renewal_window_seconds integer;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 600 then
    raise exception 'lease duration is invalid' using errcode = '22023';
  end if;
  select * into assignment_row
  from public.community_assignments where session_token_hash = p_session_token_hash;
  if assignment_row.id is null then
    raise exception 'community assignment is no longer active' using errcode = 'P0003';
  end if;
  renewal_window_seconds := greatest(15, least(60, p_lease_seconds / 2));
  perform public.community_reconcile_authority(
    assignment_row.match_id, 'session_heartbeat'
  );
  select * into assignment_row
  from public.community_assignments where id = assignment_row.id;
  if assignment_row.status <> 'ACTIVE'
    or assignment_row.lease_expires_at <= clock_timestamp()
    or not exists (
      select 1 from public.courts
      where id = assignment_row.court_id and current_match_id = assignment_row.match_id
    ) then
    raise exception 'community assignment is no longer active' using errcode = 'P0003';
  end if;
  -- Healthy frequent heartbeats are read-only. Lock and renew only in the
  -- latter half of the lease, which keeps visibility/focus recovery prompt
  -- without generating a write every few seconds for every observer.
  if assignment_row.lease_expires_at <= clock_timestamp()
      + make_interval(secs => renewal_window_seconds) then
    select * into assignment_row
    from public.community_assignments where id = assignment_row.id for update;
    if assignment_row.status <> 'ACTIVE'
      or assignment_row.lease_expires_at <= clock_timestamp()
      or not exists (
        select 1 from public.courts
        where id = assignment_row.court_id and current_match_id = assignment_row.match_id
      ) then
      raise exception 'community assignment is no longer active' using errcode = 'P0003';
    end if;
    if assignment_row.lease_expires_at <= clock_timestamp()
        + make_interval(secs => renewal_window_seconds) then
      update public.community_assignments set
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
        last_seen_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = assignment_row.id returning * into assignment_row;
    end if;
  end if;
  return public.community_session_response(assignment_row.id, false, null, null);
end;
$$;

create or replace function public.community_submit_observation(
  p_session_token_hash text,
  p_client_action_id text,
  p_base_revision bigint,
  p_action_type text,
  p_team_side text,
  p_playback_timestamp_ms bigint default null,
  p_device_sequence bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
  score_row public.score_states%rowtype;
  existing_observation public.rally_observations%rowtype;
  observation_row public.rally_observations%rowtype;
  canonical_event public.canonical_score_events%rowtype;
  target_rally_number integer;
  receipt_status text := 'RECORDED';
  receipt_message_code text := 'EVIDENCE_RECORDED';
  eligible_count integer := 0;
  leading_count integer := 0;
  leading_action text;
  leading_team text;
  next_state jsonb;
  commit_result jsonb;
  new_epoch bigint;
  vote_breakdown jsonb := '[]'::jsonb;
  has_exclusive_score_lock boolean := false;
  late_observed_count integer := 0;
  late_matching_count integer := 0;
  late_differing_count integer := 0;
  late_verified_observed_count integer := 0;
  late_verified_matching_count integer := 0;
  late_verified_differing_count integer := 0;
  late_verified_vote_breakdown jsonb := '[]'::jsonb;
begin
  if p_client_action_id is null or char_length(p_client_action_id) < 8
    or char_length(p_client_action_id) > 128 then
    raise exception 'client action id is invalid' using errcode = '22023';
  end if;
  if p_action_type not in ('ADD_POINT', 'REMOVE_POINT') or p_team_side not in ('A', 'B') then
    raise exception 'observation action is invalid' using errcode = '22023';
  end if;
  if p_base_revision < 0 or p_playback_timestamp_ms < 0 or p_device_sequence < 0 then
    raise exception 'observation sequence values are invalid' using errcode = '22023';
  end if;

  select * into assignment_row
  from public.community_assignments where session_token_hash = p_session_token_hash;
  if assignment_row.id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  -- Ordinary crowd taps share-lock the canonical row: hundreds of observers
  -- may append concurrently, while a canonical UPDATE deterministically falls
  -- before or after every captured base revision. Only a verified courtside
  -- voter that may complete consensus takes the exclusive score lock.
  has_exclusive_score_lock := assignment_row.role = 'VERIFIED_WITNESS'
    and assignment_row.trust_tier = 'VERIFIED_COURTSIDE';
  if has_exclusive_score_lock then
    select * into score_row
    from public.score_states where match_id = assignment_row.match_id for update;
    select * into assignment_row
    from public.community_assignments where id = assignment_row.id for update;
  else
    select * into score_row
    from public.score_states where match_id = assignment_row.match_id for share;
    select * into assignment_row
    from public.community_assignments where id = assignment_row.id for update;
  end if;
  if assignment_row.status <> 'ACTIVE' or assignment_row.lease_expires_at <= clock_timestamp() then
    if assignment_row.status = 'ACTIVE' then
      update public.community_assignments set status = 'EXPIRED', updated_at = clock_timestamp()
      where id = assignment_row.id;
    end if;
    raise exception 'community assignment is no longer active' using errcode = 'P0003';
  end if;
  if not exists (
    select 1 from public.courts
    where id = assignment_row.court_id and event_id = assignment_row.event_id
      and current_match_id = assignment_row.match_id and scoring_open = true and frozen = false
  ) then
    raise exception 'community assignment scope is no longer current' using errcode = 'P0003';
  end if;

  if score_row.id is null then
    raise exception 'canonical score not found' using errcode = 'P0002';
  end if;
  select * into existing_observation
  from public.rally_observations
  where assignment_id = assignment_row.id and client_action_id = p_client_action_id;
  if existing_observation.id is not null then
    return public.community_session_response(assignment_row.id, true, null, null);
  end if;
  select * into existing_observation
  from public.rally_observations
  where assignment_id = assignment_row.id and base_revision = p_base_revision;
  if existing_observation.id is not null then
    if existing_observation.action_type = p_action_type and existing_observation.team_side = p_team_side then
      return public.community_session_response(assignment_row.id, true, null, null);
    end if;
    raise exception 'a different observation is already recorded for this rally revision'
      using errcode = '23505';
  end if;
  if p_base_revision > score_row.revision then
    raise exception 'observation revision is ahead of canonical score' using errcode = '40001';
  end if;
  if score_row.revision - p_base_revision > 200 then
    raise exception 'observation is outside the accepted replay window' using errcode = '22023';
  end if;

  if p_base_revision < score_row.revision then
    select * into canonical_event
    from public.canonical_score_events
    where match_id = assignment_row.match_id
      and revision = p_base_revision + 1
      and command_type in ('ADD_POINT', 'REMOVE_POINT')
    order by authority_epoch desc
    limit 1;
    if canonical_event.id is null then
      receipt_status := 'LATE';
      receipt_message_code := 'RALLY_ALREADY_CLOSED';
      target_rally_number := score_row.current_rally_number;
    else
      target_rally_number := coalesce((canonical_event.next_state->>'currentRallyNumber')::integer, score_row.current_rally_number);
      if canonical_event.command_type = p_action_type and canonical_event.team_side = p_team_side then
        receipt_status := 'CONFIRMED';
        receipt_message_code := 'MATCHED_EARLIER_CANONICAL';
      else
        receipt_status := 'DIFFERED';
        receipt_message_code := 'EARLIER_RALLY_RESOLVED_DIFFERENTLY';
      end if;
    end if;
  else
    target_rally_number := score_row.current_rally_number + case when p_action_type = 'ADD_POINT' then 1 else 0 end;
  end if;

  insert into public.rally_observations (
    event_id, court_id, match_id, assignment_id, client_action_id,
    base_revision, rally_number, action_type, team_side,
    playback_timestamp_ms, device_sequence
  ) values (
    assignment_row.event_id, assignment_row.court_id, assignment_row.match_id,
    assignment_row.id, p_client_action_id, p_base_revision, target_rally_number,
    p_action_type, p_team_side, p_playback_timestamp_ms, p_device_sequence
  ) returning * into observation_row;
  insert into public.contribution_receipts (
    observation_id, assignment_id, event_id, court_id, match_id,
    rally_number, status, message_code, canonical_revision, resolved_at
  ) values (
    observation_row.id, assignment_row.id, assignment_row.event_id,
    assignment_row.court_id, assignment_row.match_id, target_rally_number,
    receipt_status, receipt_message_code,
    case when receipt_status = 'RECORDED' then null else canonical_event.revision end,
    case when receipt_status = 'RECORDED' then null else clock_timestamp() end
  );

  -- A canonical point commonly reaches the server before delayed witnesses.
  -- Verified late dissent must therefore be able to open the same truthful
  -- post-canonical review as dissent that arrived just before the commit.
  if receipt_status = 'DIFFERED'
    and has_exclusive_score_lock
    and canonical_event.command_type in ('ADD_POINT', 'REMOVE_POINT')
    and canonical_event.team_side in ('A', 'B') then
    select count(*)::integer,
      count(*) filter (
        where observation.action_type = canonical_event.command_type
          and observation.team_side = canonical_event.team_side
      )::integer
    into late_verified_observed_count, late_verified_matching_count
    from public.rally_observations observation
    join public.community_assignments witness on witness.id = observation.assignment_id
    where observation.match_id = assignment_row.match_id
      and observation.base_revision = p_base_revision
      and witness.role = 'VERIFIED_WITNESS'
      and witness.trust_tier = 'VERIFIED_COURTSIDE'
      and witness.status = 'ACTIVE'
      and witness.lease_expires_at > clock_timestamp();
    late_verified_differing_count := late_verified_observed_count - late_verified_matching_count;

    if late_verified_differing_count >= 2 then
      select count(*)::integer,
        count(*) filter (
          where observation.action_type = canonical_event.command_type
            and observation.team_side = canonical_event.team_side
        )::integer
      into late_observed_count, late_matching_count
      from public.rally_observations observation
      where observation.match_id = assignment_row.match_id
        and observation.base_revision = p_base_revision;
      late_differing_count := late_observed_count - late_matching_count;

      select coalesce(jsonb_agg(jsonb_build_object(
        'actionType', vote.action_type,
        'teamSide', vote.team_side,
        'count', vote.vote_count
      ) order by vote.vote_count desc, vote.action_type, vote.team_side), '[]'::jsonb)
      into late_verified_vote_breakdown
      from (
        select observation.action_type, observation.team_side, count(*)::integer as vote_count
        from public.rally_observations observation
        join public.community_assignments witness on witness.id = observation.assignment_id
        where observation.match_id = assignment_row.match_id
          and observation.base_revision = p_base_revision
          and witness.role = 'VERIFIED_WITNESS'
          and witness.trust_tier = 'VERIFIED_COURTSIDE'
          and witness.status = 'ACTIVE'
          and witness.lease_expires_at > clock_timestamp()
        group by observation.action_type, observation.team_side
      ) vote;

      insert into public.rally_resolutions (
        event_id, court_id, match_id, rally_number, canonical_event_id, status,
        action_type, team_side, witness_count, confirmed_count, differing_count
      ) values (
        assignment_row.event_id, assignment_row.court_id, assignment_row.match_id,
        target_rally_number, canonical_event.id, 'DISPUTED',
        canonical_event.command_type, canonical_event.team_side,
        late_observed_count, late_matching_count, late_differing_count
      )
      on conflict (match_id, rally_number) do update set
        canonical_event_id = excluded.canonical_event_id,
        status = 'DISPUTED',
        action_type = excluded.action_type,
        team_side = excluded.team_side,
        witness_count = excluded.witness_count,
        confirmed_count = excluded.confirmed_count,
        differing_count = excluded.differing_count,
        resolved_at = clock_timestamp(),
        updated_at = clock_timestamp();

      insert into public.score_disputes (
        event_id, court_id, match_id, rally_number, base_revision,
        canonical_event_id, expected_action_type, expected_team_side, differing_count,
        eligible_vote_count, proposal_vote_count, proposal_eligible, vote_breakdown
      ) values (
        assignment_row.event_id, assignment_row.court_id, assignment_row.match_id,
        target_rally_number, p_base_revision, canonical_event.id,
        canonical_event.command_type, canonical_event.team_side,
        late_verified_differing_count, late_verified_observed_count,
        late_verified_matching_count, false, late_verified_vote_breakdown
      )
      on conflict (match_id, rally_number) where status in ('OPEN', 'ACKNOWLEDGED')
      do nothing;

      update public.contribution_receipts receipt set
        status = 'TRIGGERED_REVIEW',
        message_code = 'OPENED_SCORE_CHECK',
        canonical_revision = canonical_event.revision,
        review_triggered_at = coalesce(receipt.review_triggered_at, clock_timestamp()),
        resolved_at = clock_timestamp(),
        updated_at = clock_timestamp()
      from public.rally_observations observation
      join public.community_assignments witness on witness.id = observation.assignment_id
      where receipt.observation_id = observation.id
        and observation.match_id = assignment_row.match_id
        and observation.base_revision = p_base_revision
        and (observation.action_type <> canonical_event.command_type
          or observation.team_side <> canonical_event.team_side)
        and witness.role = 'VERIFIED_WITNESS'
        and witness.trust_tier = 'VERIFIED_COURTSIDE'
        and witness.status = 'ACTIVE'
        and witness.lease_expires_at > clock_timestamp();
    end if;
  end if;
  -- Heartbeats own lease renewal. Avoid upgrading every observer's shared row
  -- lock and writing the assignment again for each rally tap.
  if has_exclusive_score_lock then
    update public.community_assignments set
      last_seen_at = clock_timestamp(),
      lease_expires_at = greatest(lease_expires_at, clock_timestamp() + interval '120 seconds'),
      updated_at = clock_timestamp()
    where id = assignment_row.id returning * into assignment_row;
  end if;

  -- Only independently verified courtside witnesses count toward consensus.
  if has_exclusive_score_lock
    and p_base_revision = score_row.revision
    and score_row.authority_mode = 'VERIFIED_CONSENSUS'
    and assignment_row.role = 'VERIFIED_WITNESS'
    and assignment_row.trust_tier = 'VERIFIED_COURTSIDE' then
    select count(*)::integer into eligible_count
    from public.rally_observations observation
    join public.community_assignments witness on witness.id = observation.assignment_id
    where observation.match_id = assignment_row.match_id
      and observation.base_revision = score_row.revision
      and witness.role = 'VERIFIED_WITNESS'
      and witness.trust_tier = 'VERIFIED_COURTSIDE'
      and witness.status = 'ACTIVE'
      and witness.lease_expires_at > clock_timestamp();

    select vote.action_type, vote.team_side, vote.vote_count
    into leading_action, leading_team, leading_count
    from (
      select observation.action_type, observation.team_side, count(*)::integer vote_count
      from public.rally_observations observation
      join public.community_assignments witness on witness.id = observation.assignment_id
      where observation.match_id = assignment_row.match_id
        and observation.base_revision = score_row.revision
        and witness.role = 'VERIFIED_WITNESS'
        and witness.trust_tier = 'VERIFIED_COURTSIDE'
        and witness.status = 'ACTIVE'
        and witness.lease_expires_at > clock_timestamp()
      group by observation.action_type, observation.team_side
      order by count(*) desc, observation.action_type, observation.team_side
      limit 1
    ) vote;

    select coalesce(jsonb_agg(jsonb_build_object(
      'actionType', vote.action_type,
      'teamSide', vote.team_side,
      'count', vote.vote_count
    ) order by vote.vote_count desc, vote.action_type, vote.team_side), '[]'::jsonb)
    into vote_breakdown
    from (
      select observation.action_type, observation.team_side, count(*)::integer as vote_count
      from public.rally_observations observation
      join public.community_assignments witness on witness.id = observation.assignment_id
      where observation.match_id = assignment_row.match_id
        and observation.base_revision = score_row.revision
        and witness.role = 'VERIFIED_WITNESS'
        and witness.trust_tier = 'VERIFIED_COURTSIDE'
        and witness.status = 'ACTIVE'
        and witness.lease_expires_at > clock_timestamp()
      group by observation.action_type, observation.team_side
    ) vote;

    if eligible_count >= 3 and leading_count * 3 >= eligible_count * 2 then
      next_state := public.community_reduce_score_action(
        public.community_score_input_json(score_row),
        jsonb_build_object('type', leading_action, 'team', leading_team),
        (select format from public.matches where id = assignment_row.match_id)
      );
      commit_result := public.community_commit_locked_score(
        assignment_row.match_id, null,
        'consensus:' || assignment_row.match_id::text || ':' || score_row.revision::text,
        leading_action, leading_team, 'CONSENSUS', 'Verified witness consensus',
        score_row.revision, score_row.authority_epoch, 'VERIFIED_CONSENSUS',
        next_state,
        jsonb_build_object(
          'source', 'manual', 'sourceAvailable', false,
          'sourcePriority', 'fallback', 'sourcePendingScores', '[]'::jsonb,
          'stale', false, 'message', null
        ),
        jsonb_build_object('eligibleVotes', eligible_count, 'agreeingVotes', leading_count)
      );
      return public.community_session_response(
        assignment_row.id, false,
        nullif(commit_result->>'eventId', '')::uuid,
        nullif(commit_result->>'outboxId', '')::uuid
      );
    elsif eligible_count >= 5 then
      new_epoch := score_row.authority_epoch + 1;
      update public.score_states set authority_epoch = new_epoch,
        authority_mode = 'PAUSED_DISPUTE', updated_at = clock_timestamp()
      where id = score_row.id returning * into score_row;
      insert into public.canonical_score_events (
        event_id, court_id, match_id, revision, authority_epoch, authority_mode,
        command_id, command_type, actor_type, actor_label,
        previous_state, next_state, state_hash, metadata
      ) values (
        assignment_row.event_id, assignment_row.court_id, assignment_row.match_id,
        score_row.revision, new_epoch, 'PAUSED_DISPUTE',
        'consensus-dispute:' || assignment_row.match_id::text || ':' || p_base_revision::text,
        'AUTHORITY_CHANGE', 'SYSTEM', 'Consensus conflict',
        public.community_score_input_json(score_row), public.community_score_input_json(score_row),
        score_row.state_hash, jsonb_build_object('eligibleVotes', eligible_count)
      ) returning * into canonical_event;
      insert into public.score_disputes (
        event_id, court_id, match_id, rally_number, base_revision,
        canonical_event_id, expected_action_type, expected_team_side, differing_count,
        eligible_vote_count, proposal_vote_count, proposal_eligible, vote_breakdown
      ) values (
        assignment_row.event_id, assignment_row.court_id, assignment_row.match_id,
        target_rally_number, p_base_revision, canonical_event.id,
        leading_action, leading_team, eligible_count - leading_count,
        eligible_count, leading_count, leading_count * 2 > eligible_count, vote_breakdown
      )
      on conflict (match_id, rally_number) where status in ('OPEN', 'ACKNOWLEDGED')
      do nothing;
      update public.contribution_receipts receipt set
        status = 'TRIGGERED_REVIEW', message_code = 'CONSENSUS_PAUSED_FOR_REVIEW',
        review_triggered_at = coalesce(receipt.review_triggered_at, clock_timestamp()),
        updated_at = clock_timestamp()
      from public.rally_observations observation
      join public.community_assignments witness on witness.id = observation.assignment_id
      where receipt.observation_id = observation.id
        and observation.match_id = assignment_row.match_id
        and observation.base_revision = p_base_revision
        and witness.role = 'VERIFIED_WITNESS'
        and witness.trust_tier = 'VERIFIED_COURTSIDE';
    end if;
  end if;
  return public.community_session_response(assignment_row.id, false, canonical_event.id, null);
end;
$$;

create or replace function public.community_submit_scorer_command(
  p_session_token_hash text,
  p_client_action_id text,
  p_expected_revision bigint,
  p_action jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
  score_row public.score_states%rowtype;
  action_type text := p_action->>'type';
  team_side text := p_action->>'team';
  next_state jsonb;
begin
  select * into assignment_row
  from public.community_assignments where session_token_hash = p_session_token_hash;
  if assignment_row.id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  select * into score_row from public.score_states where match_id = assignment_row.match_id for update;
  select * into assignment_row from public.community_assignments where id = assignment_row.id for update;
  if assignment_row.status <> 'ACTIVE' or assignment_row.lease_expires_at <= clock_timestamp() then
    raise exception 'community assignment is no longer active' using errcode = 'P0003';
  end if;
  if assignment_row.role <> 'DESIGNATED_SCORER' then
    raise exception 'assignment cannot issue canonical commands' using errcode = '28000';
  end if;
  if not exists (
    select 1 from public.courts where id = assignment_row.court_id
      and event_id = assignment_row.event_id and current_match_id = assignment_row.match_id
      and scoring_open = true and frozen = false
  ) then
    raise exception 'community assignment scope is no longer current' using errcode = 'P0003';
  end if;
  if score_row.authority_mode <> 'DESIGNATED_PRIMARY'
    or assignment_row.authority_epoch <> score_row.authority_epoch then
    raise exception 'designated scorer no longer owns score authority' using errcode = '40001';
  end if;
  next_state := public.community_reduce_score_action(
    public.community_score_input_json(score_row), p_action,
    (select format from public.matches where id = assignment_row.match_id)
  );
  update public.community_assignments set
    last_seen_at = clock_timestamp(),
    lease_expires_at = greatest(lease_expires_at, clock_timestamp() + interval '120 seconds'),
    updated_at = clock_timestamp()
  where id = assignment_row.id;
  return public.community_commit_locked_score(
    assignment_row.match_id, assignment_row.id, p_client_action_id,
    action_type, team_side, 'COMMUNITY_SCORER', assignment_row.display_name,
    p_expected_revision, assignment_row.authority_epoch, 'DESIGNATED_PRIMARY',
    next_state,
    jsonb_build_object(
      'source', 'manual', 'sourceAvailable', false,
      'sourcePriority', 'fallback', 'sourcePendingScores', '[]'::jsonb,
      'stale', false, 'message', null
    ),
    '{}'::jsonb
  );
end;
$$;

create or replace function public.community_commit_trusted_score(
  p_event_id uuid,
  p_court_id uuid,
  p_match_id uuid,
  p_action_id text,
  p_actor_type text,
  p_actor_label text,
  p_authority_mode text,
  p_expected_revision bigint,
  p_expected_authority_epoch bigint,
  p_state jsonb,
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
  court_row public.courts%rowtype;
  score_row public.score_states%rowtype;
begin
  if p_actor_type not in ('ADMIN', 'PROVIDER', 'SYSTEM') then
    raise exception 'trusted actor type is invalid' using errcode = '22023';
  end if;
  if p_actor_type = 'PROVIDER' and p_authority_mode <> 'PROVIDER_PRIMARY' then
    raise exception 'provider commits require PROVIDER_PRIMARY authority' using errcode = '23514';
  end if;
  if p_command_type not in ('ADD_POINT', 'REMOVE_POINT', 'CORRECT_SCORE', 'COMPLETE_SET', 'COMPLETE_MATCH', 'SET_SERVE')
    or (p_team_side is not null and p_team_side not in ('A', 'B'))
    or (p_command_type in ('ADD_POINT', 'REMOVE_POINT', 'SET_SERVE') and p_team_side is null) then
    raise exception 'trusted command semantics are invalid' using errcode = '22023';
  end if;
  select * into court_row from public.courts where id = p_court_id for update;
  if court_row.id is null or court_row.event_id <> p_event_id or court_row.current_match_id <> p_match_id then
    raise exception 'trusted score scope is not current' using errcode = '23514';
  end if;
  score_row := public.community_ensure_score_projection(
    p_event_id, p_court_id, p_match_id, p_authority_mode
  );
  if p_actor_type = 'PROVIDER' and score_row.authority_mode = 'ADMIN_LOCKED' then
    raise exception 'admin lock blocks provider score commits' using errcode = '55000';
  end if;
  return public.community_commit_locked_score(
    p_match_id, null, p_action_id, p_command_type, p_team_side,
    p_actor_type, p_actor_label, p_expected_revision, p_expected_authority_epoch,
    p_authority_mode, p_state, p_projection_metadata, p_metadata
  );
end;
$$;

create or replace function public.community_mark_score_outbox(
  p_outbox_id uuid,
  p_revision bigint,
  p_outcome text,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  outbox_row public.canonical_score_outbox%rowtype;
begin
  if p_outcome not in ('PUBLISHED', 'FAILED') then
    raise exception 'outbox outcome is invalid' using errcode = '22023';
  end if;
  select * into outbox_row from public.canonical_score_outbox where id = p_outbox_id for update;
  if outbox_row.id is null or outbox_row.revision <> p_revision then
    raise exception 'outbox revision not found' using errcode = 'P0002';
  end if;
  if outbox_row.status = 'PUBLISHED' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'outboxId', outbox_row.id,
      'revision', outbox_row.revision, 'status', outbox_row.status);
  end if;
  update public.canonical_score_outbox set
    status = p_outcome,
    attempt_count = attempt_count + 1,
    last_error = case when p_outcome = 'FAILED' then left(coalesce(p_error, 'overlay publish failed'), 1000) else null end,
    claimed_by = null,
    claimed_at = null,
    claim_expires_at = null,
    next_attempt_at = case
      when p_outcome = 'FAILED' then clock_timestamp() + make_interval(secs => least(300, (2 ^ least(attempt_count, 8))::integer))
      else next_attempt_at
    end,
    published_at = case when p_outcome = 'PUBLISHED' then clock_timestamp() else null end,
    updated_at = clock_timestamp()
  where id = outbox_row.id
  returning * into outbox_row;
  return jsonb_build_object('ok', true, 'duplicate', false, 'outboxId', outbox_row.id,
    'revision', outbox_row.revision, 'status', outbox_row.status,
    'attemptCount', outbox_row.attempt_count, 'nextAttemptAt', outbox_row.next_attempt_at);
end;
$$;

-- Publish a rendered overlay and close its outbox item in one transaction.
-- The renderer may build from a newer canonical revision than the outbox item
-- being drained, but the locked current score must still equal the supplied
-- projection revision before any court or overlay state changes.
create or replace function public.community_publish_score_outbox(
  p_outbox_id uuid,
  p_projection_revision bigint,
  p_overlay_payload jsonb,
  p_court_status text,
  p_stale boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  outbox_row public.canonical_score_outbox%rowtype;
  court_row public.courts%rowtype;
  score_row public.score_states%rowtype;
  response_status text;
begin
  if p_projection_revision is null or p_projection_revision < 1 then
    raise exception 'projection revision is invalid' using errcode = '22023';
  end if;

  select * into outbox_row
  from public.canonical_score_outbox
  where id = p_outbox_id
  for update;
  if outbox_row.id is null then
    raise exception 'score outbox item not found' using errcode = 'P0002';
  end if;

  select * into court_row
  from public.courts
  where id = outbox_row.court_id
  for update;
  if court_row.id is null or court_row.event_id <> outbox_row.event_id then
    raise exception 'score outbox court scope is invalid' using errcode = '23514';
  end if;

  -- A duplicate must never replay an overlay. Its response still reflects the
  -- court's current match so a late caller cannot return stale overlay data.
  if outbox_row.status = 'PUBLISHED' then
    response_status := case
      when court_row.current_match_id = outbox_row.match_id then 'PUBLISHED'
      else 'HISTORICAL'
    end;
    return jsonb_build_object(
      'ok', true,
      'outboxId', outbox_row.id,
      'revision', outbox_row.revision,
      'status', response_status,
      'duplicate', true
    );
  end if;

  -- A transitioned match is historical. Close the item without validating or
  -- touching the supplied overlay payload, which may intentionally be empty.
  if court_row.current_match_id is distinct from outbox_row.match_id then
    update public.canonical_score_outbox set
      status = 'PUBLISHED',
      attempt_count = attempt_count + 1,
      claimed_by = null,
      claimed_at = null,
      claim_expires_at = null,
      last_error = null,
      published_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where id = outbox_row.id
    returning * into outbox_row;
    return jsonb_build_object(
      'ok', true,
      'outboxId', outbox_row.id,
      'revision', outbox_row.revision,
      'status', 'HISTORICAL',
      'duplicate', false
    );
  end if;

  select * into score_row
  from public.score_states
  where match_id = outbox_row.match_id
  for update;
  if score_row.id is null or score_row.court_id <> court_row.id then
    raise exception 'canonical score projection is outside the outbox scope' using errcode = '23514';
  end if;

  -- Leave the claim/status exactly as-is. The caller must rebuild from this
  -- returned revision and retry the same outbox item under its existing lease.
  if score_row.revision <> p_projection_revision then
    return jsonb_build_object(
      'ok', true,
      'outboxId', outbox_row.id,
      'revision', outbox_row.revision,
      'status', 'RETRY',
      'duplicate', false,
      'currentRevision', score_row.revision
    );
  end if;

  if p_court_status is null or p_court_status not in ('waiting', 'live', 'finished') then
    raise exception 'projected court status is invalid' using errcode = '22023';
  end if;
  if p_stale is null or p_overlay_payload is null or jsonb_typeof(p_overlay_payload) <> 'object' then
    raise exception 'overlay projection is invalid' using errcode = '22023';
  end if;
  if p_overlay_payload->>'eventId' is distinct from outbox_row.event_id::text
    or p_overlay_payload->>'courtId' is distinct from court_row.id::text
    or p_overlay_payload->'match'->>'id' is distinct from outbox_row.match_id::text then
    raise exception 'overlay projection scope does not match its outbox item' using errcode = '23514';
  end if;

  update public.courts set
    status = p_court_status,
    last_update_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = court_row.id;

  insert into public.overlay_states (
    court_id, event_id, court_number, payload, stale, updated_at
  ) values (
    court_row.id, court_row.event_id, court_row.court_number,
    p_overlay_payload, p_stale, clock_timestamp()
  )
  on conflict (court_id) do update set
    event_id = excluded.event_id,
    court_number = excluded.court_number,
    payload = excluded.payload,
    stale = excluded.stale,
    updated_at = excluded.updated_at;

  update public.canonical_score_outbox set
    status = 'PUBLISHED',
    attempt_count = attempt_count + 1,
    claimed_by = null,
    claimed_at = null,
    claim_expires_at = null,
    last_error = null,
    published_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = outbox_row.id
  returning * into outbox_row;

  return jsonb_build_object(
    'ok', true,
    'outboxId', outbox_row.id,
    'revision', outbox_row.revision,
    'status', 'PUBLISHED',
    'duplicate', false
  );
end;
$$;

create or replace function public.community_claim_score_outbox(
  p_worker_id text,
  p_limit integer default 20,
  p_lease_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claimed jsonb;
begin
  if p_worker_id is null or char_length(btrim(p_worker_id)) < 1
    or char_length(p_worker_id) > 120 then
    raise exception 'outbox worker id is invalid' using errcode = '22023';
  end if;
  if p_limit < 1 or p_limit > 100 or p_lease_seconds < 5 or p_lease_seconds > 300 then
    raise exception 'outbox claim bounds are invalid' using errcode = '22023';
  end if;
  with candidates as (
    select id
    from public.canonical_score_outbox
    where (
      status in ('PENDING', 'FAILED') and next_attempt_at <= clock_timestamp()
    ) or (
      status = 'PROCESSING' and claim_expires_at <= clock_timestamp()
    )
    order by created_at
    for update skip locked
    limit p_limit
  ), updated as (
    update public.canonical_score_outbox outbox set
      status = 'PROCESSING',
      claimed_by = btrim(p_worker_id),
      claimed_at = clock_timestamp(),
      claim_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      updated_at = clock_timestamp()
    from candidates
    where outbox.id = candidates.id
    returning outbox.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id,
    'eventId', event_id,
    'courtId', court_id,
    'matchId', match_id,
    'revision', revision,
    'scorePayload', score_payload,
    'attemptCount', attempt_count,
    'claimExpiresAt', claim_expires_at
  ) order by created_at), '[]'::jsonb)
  into claimed
  from updated;
  return claimed;
end;
$$;

create or replace function public.community_end_assignment_internal(
  p_assignment_id uuid,
  p_end_status text,
  p_action_id text,
  p_actor_label text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
  score_row public.score_states%rowtype;
  authority_event public.canonical_score_events%rowtype;
  new_epoch bigint;
  fallback_mode text;
begin
  if p_end_status not in ('RELEASED', 'REVOKED') then
    raise exception 'assignment end status is invalid' using errcode = '22023';
  end if;
  select * into assignment_row
  from public.community_assignments where id = p_assignment_id;
  if assignment_row.id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  select * into score_row from public.score_states where match_id = assignment_row.match_id for update;
  select * into assignment_row from public.community_assignments where id = p_assignment_id for update;
  if exists (
    select 1 from public.canonical_score_events
    where command_id = p_action_id and assignment_id = p_assignment_id
  ) then
    return public.community_session_response(assignment_row.id, true, null, null);
  end if;
  if assignment_row.status <> 'ACTIVE' then
    return public.community_session_response(assignment_row.id, true, null, null);
  end if;
  update public.community_assignments set
    status = p_end_status,
    released_at = case when p_end_status = 'RELEASED' then clock_timestamp() else released_at end,
    revoked_at = case when p_end_status = 'REVOKED' then clock_timestamp() else revoked_at end,
    updated_at = clock_timestamp()
  where id = assignment_row.id returning * into assignment_row;

  if assignment_row.role = 'DESIGNATED_SCORER'
    and score_row.authority_mode = 'DESIGNATED_PRIMARY'
    and score_row.authority_epoch = assignment_row.authority_epoch then
    new_epoch := score_row.authority_epoch + 1;
    fallback_mode := public.community_fallback_mode(assignment_row.match_id);
    update public.score_states set authority_epoch = new_epoch,
      authority_mode = fallback_mode, updated_at = clock_timestamp()
    where id = score_row.id returning * into score_row;
    insert into public.canonical_score_events (
      event_id, court_id, match_id, assignment_id, revision, authority_epoch,
      authority_mode, command_id, command_type, actor_type, actor_label,
      previous_state, next_state, state_hash, metadata
    ) values (
      assignment_row.event_id, assignment_row.court_id, assignment_row.match_id,
      assignment_row.id, score_row.revision, new_epoch, fallback_mode,
      p_action_id, 'ASSIGNMENT_RELEASED', 'SYSTEM', p_actor_label,
      public.community_score_input_json(score_row), public.community_score_input_json(score_row),
      score_row.state_hash, jsonb_build_object('assignmentStatus', p_end_status, 'fallbackMode', fallback_mode)
    ) returning * into authority_event;
  end if;
  return public.community_session_response(assignment_row.id, false, authority_event.id, null);
end;
$$;

create or replace function public.community_release_assignment(
  p_session_token_hash text,
  p_action_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_id uuid;
begin
  select id into assignment_id
  from public.community_assignments where session_token_hash = p_session_token_hash;
  if assignment_id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  return public.community_end_assignment_internal(
    assignment_id, 'RELEASED', p_action_id, 'Community participant'
  );
end;
$$;

create or replace function public.community_admin_end_assignment(
  p_assignment_id uuid,
  p_action text,
  p_action_id text,
  p_actor_label text default 'Admin'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_action not in ('RELEASE', 'REVOKE') then
    raise exception 'admin assignment action is invalid' using errcode = '22023';
  end if;
  return public.community_end_assignment_internal(
    p_assignment_id,
    case when p_action = 'RELEASE' then 'RELEASED' else 'REVOKED' end,
    p_action_id,
    p_actor_label
  );
end;
$$;

create or replace function public.community_verify_assignment(
  p_assignment_id uuid,
  p_action_id text,
  p_actor_label text default 'Admin'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
  score_row public.score_states%rowtype;
  verified_count integer;
  new_epoch bigint;
begin
  select * into assignment_row
  from public.community_assignments where id = p_assignment_id;
  if assignment_row.id is null or assignment_row.status <> 'ACTIVE'
    or assignment_row.lease_expires_at <= clock_timestamp() then
    raise exception 'active assignment not found' using errcode = 'P0002';
  end if;
  select * into score_row from public.score_states where match_id = assignment_row.match_id for update;
  select * into assignment_row from public.community_assignments where id = p_assignment_id for update;
  if assignment_row.status <> 'ACTIVE' or assignment_row.lease_expires_at <= clock_timestamp() then
    raise exception 'active assignment not found' using errcode = 'P0002';
  end if;
  if assignment_row.role = 'DESIGNATED_SCORER' then
    raise exception 'designated scorer cannot be converted to witness' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.canonical_score_events
    where command_id = p_action_id and assignment_id = p_assignment_id
  ) or (
    assignment_row.role = 'VERIFIED_WITNESS'
    and assignment_row.trust_tier = 'VERIFIED_COURTSIDE'
  ) then
    return public.community_session_response(assignment_row.id, true, null, null);
  end if;
  update public.community_assignments set
    role = 'VERIFIED_WITNESS', trust_tier = 'VERIFIED_COURTSIDE',
    updated_at = clock_timestamp()
  where id = assignment_row.id returning * into assignment_row;
  select count(*)::integer into verified_count
  from public.community_assignments
  where match_id = assignment_row.match_id and role = 'VERIFIED_WITNESS'
    and trust_tier = 'VERIFIED_COURTSIDE' and status = 'ACTIVE'
    and lease_expires_at > clock_timestamp();
  if verified_count >= 3 and score_row.authority_mode = 'PAUSED_DISPUTE' then
    new_epoch := score_row.authority_epoch + 1;
    update public.score_states set authority_epoch = new_epoch,
      authority_mode = 'VERIFIED_CONSENSUS', updated_at = clock_timestamp()
    where id = score_row.id returning * into score_row;
    update public.community_assignments set authority_epoch = new_epoch,
      updated_at = clock_timestamp()
    where match_id = assignment_row.match_id and role = 'VERIFIED_WITNESS' and status = 'ACTIVE';
    insert into public.canonical_score_events (
      event_id, court_id, match_id, assignment_id, revision, authority_epoch,
      authority_mode, command_id, command_type, actor_type, actor_label,
      previous_state, next_state, state_hash, metadata
    ) values (
      assignment_row.event_id, assignment_row.court_id, assignment_row.match_id,
      assignment_row.id, score_row.revision, new_epoch, 'VERIFIED_CONSENSUS',
      p_action_id, 'AUTHORITY_CHANGE', 'ADMIN', p_actor_label,
      public.community_score_input_json(score_row), public.community_score_input_json(score_row),
      score_row.state_hash, jsonb_build_object('reason', 'verified_witness_quorum', 'count', verified_count)
    );
  end if;
  return public.community_session_response(assignment_row.id, false, null, null);
end;
$$;

create or replace function public.community_promote_assignment(
  p_assignment_id uuid,
  p_expected_authority_epoch bigint,
  p_action_id text,
  p_actor_label text default 'Admin'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  assignment_row public.community_assignments%rowtype;
  score_row public.score_states%rowtype;
  new_epoch bigint;
  authority_event public.canonical_score_events%rowtype;
begin
  select * into assignment_row
  from public.community_assignments where id = p_assignment_id;
  if assignment_row.id is null or assignment_row.status <> 'ACTIVE'
    or assignment_row.lease_expires_at <= clock_timestamp()
    or assignment_row.trust_tier <> 'VERIFIED_COURTSIDE'
    or assignment_row.role not in ('VERIFIED_WITNESS', 'DESIGNATED_SCORER') then
    raise exception 'verified active assignment is required' using errcode = '23514';
  end if;
  select * into score_row from public.score_states where match_id = assignment_row.match_id for update;
  select * into assignment_row from public.community_assignments where id = p_assignment_id for update;
  if assignment_row.status <> 'ACTIVE'
    or assignment_row.lease_expires_at <= clock_timestamp()
    or assignment_row.trust_tier <> 'VERIFIED_COURTSIDE'
    or assignment_row.role not in ('VERIFIED_WITNESS', 'DESIGNATED_SCORER') then
    raise exception 'verified active assignment is required' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.canonical_score_events
    where command_id = p_action_id and assignment_id = p_assignment_id
  ) then
    return public.community_session_response(assignment_row.id, true, null, null);
  end if;
  if score_row.authority_epoch <> p_expected_authority_epoch then
    raise exception 'authority epoch conflict' using errcode = '40001';
  end if;
  if score_row.authority_mode in ('ADMIN_LOCKED', 'PROVIDER_PRIMARY') then
    raise exception 'current source authority blocks scorer promotion' using errcode = '55000';
  end if;
  update public.community_assignments set status = 'EXPIRED', updated_at = clock_timestamp()
  where match_id = assignment_row.match_id and status = 'ACTIVE'
    and lease_expires_at <= clock_timestamp();
  update public.community_assignments set status = 'REVOKED', revoked_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where match_id = assignment_row.match_id and role = 'DESIGNATED_SCORER'
    and status = 'ACTIVE' and id <> assignment_row.id;
  new_epoch := score_row.authority_epoch + 1;
  update public.community_assignments set role = 'DESIGNATED_SCORER',
    authority_epoch = new_epoch,
    lease_expires_at = greatest(lease_expires_at, clock_timestamp() + interval '120 seconds'),
    updated_at = clock_timestamp()
  where id = assignment_row.id returning * into assignment_row;
  update public.score_states set authority_epoch = new_epoch,
    authority_mode = 'DESIGNATED_PRIMARY', updated_at = clock_timestamp()
  where id = score_row.id returning * into score_row;
  insert into public.canonical_score_events (
    event_id, court_id, match_id, assignment_id, revision, authority_epoch,
    authority_mode, command_id, command_type, actor_type, actor_label,
    previous_state, next_state, state_hash, metadata
  ) values (
    assignment_row.event_id, assignment_row.court_id, assignment_row.match_id,
    assignment_row.id, score_row.revision, new_epoch, 'DESIGNATED_PRIMARY',
    p_action_id, 'ASSIGNMENT_PROMOTED', 'ADMIN', p_actor_label,
    public.community_score_input_json(score_row), public.community_score_input_json(score_row),
    score_row.state_hash, jsonb_build_object('reason', 'admin_promotion')
  ) returning * into authority_event;
  return public.community_session_response(assignment_row.id, false, authority_event.id, null);
end;
$$;

create or replace function public.community_change_authority(
  p_match_id uuid,
  p_authority_mode text,
  p_expected_authority_epoch bigint,
  p_action_id text,
  p_actor_type text,
  p_actor_label text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  score_row public.score_states%rowtype;
  scope_event_id uuid;
  new_epoch bigint;
  previous_mode text;
  verified_count integer;
begin
  if p_authority_mode not in (
    'ADMIN_LOCKED', 'PROVIDER_PRIMARY', 'DESIGNATED_PRIMARY',
    'VERIFIED_CONSENSUS', 'PAUSED_DISPUTE'
  ) or p_actor_type not in ('ADMIN', 'PROVIDER', 'SYSTEM') then
    raise exception 'authority transition is invalid' using errcode = '22023';
  end if;
  select * into score_row from public.score_states where match_id = p_match_id for update;
  if exists (
    select 1 from public.canonical_score_events
    where command_id = p_action_id and match_id = p_match_id
  ) then
    return jsonb_build_object('ok', true, 'duplicate', true,
      'match', public.community_match_json(p_match_id),
      'score', public.community_score_state_json(score_row),
      'community', public.community_engagement_json(p_match_id, null));
  end if;
  if score_row.id is null or score_row.authority_epoch <> p_expected_authority_epoch then
    raise exception 'authority epoch conflict' using errcode = '40001';
  end if;
  previous_mode := score_row.authority_mode;
  if p_authority_mode = 'VERIFIED_CONSENSUS' then
    select count(*)::integer into verified_count
    from public.community_assignments
    where match_id = p_match_id and role = 'VERIFIED_WITNESS'
      and trust_tier = 'VERIFIED_COURTSIDE' and status = 'ACTIVE'
      and lease_expires_at > clock_timestamp();
    if verified_count < 3 then
      raise exception 'verified consensus requires three live verified witnesses' using errcode = '23514';
    end if;
  end if;
  if score_row.authority_mode = p_authority_mode then
    return jsonb_build_object('ok', true, 'duplicate', true,
      'match', public.community_match_json(p_match_id),
      'score', public.community_score_state_json(score_row),
      'community', public.community_engagement_json(p_match_id, null));
  end if;
  if p_authority_mode = 'DESIGNATED_PRIMARY' and not exists (
    select 1 from public.community_assignments
    where match_id = p_match_id and role = 'DESIGNATED_SCORER'
      and status = 'ACTIVE' and lease_expires_at > clock_timestamp()
  ) then
    raise exception 'designated authority requires an active scorer' using errcode = '23514';
  end if;
  select court.event_id into scope_event_id from public.courts court where id = score_row.court_id;
  new_epoch := score_row.authority_epoch + 1;
  if p_authority_mode = 'DESIGNATED_PRIMARY' then
    update public.community_assignments set authority_epoch = new_epoch, updated_at = clock_timestamp()
    where match_id = p_match_id and role = 'DESIGNATED_SCORER' and status = 'ACTIVE';
  end if;
  update public.score_states set authority_epoch = new_epoch,
    authority_mode = p_authority_mode, updated_at = clock_timestamp()
  where id = score_row.id returning * into score_row;
  insert into public.canonical_score_events (
    event_id, court_id, match_id, revision, authority_epoch, authority_mode,
    command_id, command_type, actor_type, actor_label,
    previous_state, next_state, state_hash, metadata
  ) values (
    scope_event_id, score_row.court_id, p_match_id, score_row.revision,
    new_epoch, p_authority_mode, p_action_id, 'AUTHORITY_CHANGE', p_actor_type,
    p_actor_label, public.community_score_input_json(score_row),
    public.community_score_input_json(score_row), score_row.state_hash,
    jsonb_build_object('previousAuthorityMode', previous_mode)
  );
  return jsonb_build_object('ok', true, 'duplicate', false,
    'match', public.community_match_json(p_match_id),
    'score', public.community_score_state_json(score_row),
    'community', public.community_engagement_json(p_match_id, null));
end;
$$;

create or replace function public.community_create_join_grant(
  p_event_id uuid,
  p_court_id uuid,
  p_match_id uuid,
  p_action_id uuid,
  p_token_hash text,
  p_grant_role text,
  p_label text,
  p_max_uses integer,
  p_expires_at timestamptz,
  p_created_by text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  grant_row public.community_join_grants%rowtype;
  court_row public.courts%rowtype;
begin
  if p_grant_role not in ('OBSERVER', 'VERIFIED_WITNESS', 'DESIGNATED_SCORER')
    or p_max_uses < 1 or p_max_uses > 1000 or p_expires_at <= clock_timestamp() then
    raise exception 'join grant configuration is invalid' using errcode = '22023';
  end if;
  if p_token_hash is distinct from encode(extensions.digest(
    convert_to('mcs:v1:' || p_action_id::text, 'UTF8'), 'sha256'
  ), 'hex') then
    raise exception 'join grant token does not match its action id' using errcode = '22023';
  end if;
  select * into court_row
  from public.courts where id = p_court_id for update;
  if court_row.id is null
    or court_row.event_id <> p_event_id
    or court_row.current_match_id <> p_match_id then
    raise exception 'join grant scope is not current' using errcode = '23514';
  end if;
  select * into grant_row
  from public.community_join_grants
  where action_id = p_action_id or token_hash = p_token_hash
  for update;
  if grant_row.id is not null then
    if grant_row.action_id <> p_action_id
      or grant_row.token_hash <> p_token_hash
      or grant_row.event_id <> p_event_id
      or grant_row.court_id <> p_court_id
      or grant_row.match_id <> p_match_id
      or grant_row.grant_role <> p_grant_role
      or grant_row.max_uses <> p_max_uses
      or grant_row.label is distinct from nullif(btrim(p_label), '')
      or grant_row.created_by <> p_created_by then
      raise exception 'join grant action id was reused with different scope or configuration' using errcode = '23514';
    end if;
    return jsonb_build_object(
      'id', grant_row.id, 'eventId', grant_row.event_id,
      'courtId', grant_row.court_id, 'matchId', grant_row.match_id,
      'role', grant_row.grant_role, 'label', grant_row.label,
      'maxUses', grant_row.max_uses, 'expiresAt', grant_row.expires_at,
      'duplicate', true
    );
  end if;
  insert into public.community_join_grants (
    event_id, court_id, match_id, action_id, token_hash, grant_role, label,
    max_uses, expires_at, created_by
  ) values (
    p_event_id, p_court_id, p_match_id, p_action_id, p_token_hash, p_grant_role,
    nullif(btrim(p_label), ''), p_max_uses, p_expires_at, p_created_by
  ) returning * into grant_row;
  return jsonb_build_object(
    'id', grant_row.id, 'eventId', grant_row.event_id,
    'courtId', grant_row.court_id, 'matchId', grant_row.match_id,
    'role', grant_row.grant_role, 'label', grant_row.label,
    'maxUses', grant_row.max_uses, 'expiresAt', grant_row.expires_at,
    'duplicate', false
  );
end;
$$;

create or replace function public.community_transition_match(
  p_event_id uuid,
  p_court_id uuid,
  p_from_match_id uuid,
  p_to_match_id uuid,
  p_action_id text,
  p_actor_type text,
  p_actor_label text,
  p_initial_authority_mode text default 'PAUSED_DISPUTE'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  court_row public.courts%rowtype;
  old_score public.score_states%rowtype;
  new_score public.score_states%rowtype;
  new_epoch bigint;
  transition_event public.canonical_score_events%rowtype;
  previous_new_authority_mode text;
begin
  if p_actor_type not in ('ADMIN', 'PROVIDER', 'SYSTEM') then
    raise exception 'match transition actor is invalid' using errcode = '22023';
  end if;
  select * into court_row from public.courts where id = p_court_id for update;
  if court_row.id is null or court_row.event_id <> p_event_id then
    raise exception 'court transition scope is invalid' using errcode = '23514';
  end if;
  select * into transition_event
  from public.canonical_score_events where command_id = p_action_id;
  if transition_event.id is not null then
    return jsonb_build_object('ok', true, 'duplicate', true,
      'eventId', transition_event.id,
      'oldMatchId', p_from_match_id, 'newMatchId', court_row.current_match_id,
      'match', case when court_row.current_match_id is null then null else public.community_match_json(court_row.current_match_id) end,
      'score', case when court_row.current_match_id is null then null else
        public.community_score_state_json((select score from public.score_states score where score.match_id = court_row.current_match_id)) end,
      'community', case when court_row.current_match_id is null then null else
        public.community_engagement_json(court_row.current_match_id, null) end);
  end if;
  if court_row.current_match_id = p_to_match_id then
    return jsonb_build_object('ok', true, 'duplicate', true,
      'oldMatchId', p_from_match_id, 'newMatchId', p_to_match_id,
      'score', case when p_to_match_id is null then null else
        public.community_score_state_json((select score from public.score_states score where score.match_id = p_to_match_id)) end,
      'community', case when p_to_match_id is null then null else
        public.community_engagement_json(p_to_match_id, null) end);
  end if;
  if court_row.current_match_id is distinct from p_from_match_id then
    raise exception 'court match changed before transition' using errcode = '40001';
  end if;
  if p_to_match_id is not null and not exists (
    select 1 from public.matches where id = p_to_match_id and event_id = p_event_id
  ) then
    raise exception 'next match is outside the event' using errcode = '23514';
  end if;

  if p_from_match_id is not null then
    select * into old_score from public.score_states where match_id = p_from_match_id for update;
    update public.community_assignments set status = 'MATCH_ENDED', ended_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where match_id = p_from_match_id and status = 'ACTIVE';
    update public.community_join_grants set revoked_at = clock_timestamp()
    where match_id = p_from_match_id and revoked_at is null;
    if old_score.id is not null then
      new_epoch := old_score.authority_epoch + 1;
      update public.score_states set authority_epoch = new_epoch,
        authority_mode = 'PAUSED_DISPUTE', updated_at = clock_timestamp()
      where id = old_score.id returning * into old_score;
      insert into public.canonical_score_events (
        event_id, court_id, match_id, revision, authority_epoch, authority_mode,
        command_id, command_type, actor_type, actor_label,
        previous_state, next_state, state_hash, metadata
      ) values (
        p_event_id, p_court_id, p_from_match_id, old_score.revision, new_epoch,
        'PAUSED_DISPUTE', p_action_id, 'MATCH_TRANSITION', p_actor_type,
        p_actor_label, public.community_score_input_json(old_score),
        public.community_score_input_json(old_score), old_score.state_hash,
        jsonb_build_object('nextMatchId', p_to_match_id)
      ) returning * into transition_event;
    end if;
  end if;
  update public.courts set current_match_id = p_to_match_id, updated_at = clock_timestamp()
  where id = p_court_id returning * into court_row;
  if p_to_match_id is not null then
    new_score := public.community_ensure_score_projection(
      p_event_id, p_court_id, p_to_match_id, p_initial_authority_mode
    );
    if transition_event.id is null then
      -- NULL -> match activation previously had no durable base command when
      -- the ensured projection already used the requested authority. Always
      -- create an epoch boundary and immutable MATCH_TRANSITION event so a
      -- lost-response retry cannot reuse this action id for another target.
      previous_new_authority_mode := new_score.authority_mode;
      new_epoch := new_score.authority_epoch + 1;
      update public.score_states set authority_epoch = new_epoch,
        authority_mode = p_initial_authority_mode, updated_at = clock_timestamp()
      where id = new_score.id returning * into new_score;
      update public.community_assignments set authority_epoch = new_epoch,
        updated_at = clock_timestamp()
      where match_id = p_to_match_id and status = 'ACTIVE'
        and lease_expires_at > clock_timestamp();
      insert into public.canonical_score_events (
        event_id, court_id, match_id, revision, authority_epoch, authority_mode,
        command_id, command_type, actor_type, actor_label,
        previous_state, next_state, state_hash, metadata
      ) values (
        p_event_id, p_court_id, p_to_match_id, new_score.revision, new_epoch,
        p_initial_authority_mode, p_action_id, 'MATCH_TRANSITION',
        p_actor_type, p_actor_label, public.community_score_input_json(new_score),
        public.community_score_input_json(new_score), new_score.state_hash,
        jsonb_build_object(
          'reason', 'match_transition_activation',
          'previousMatchId', p_from_match_id,
          'nextMatchId', p_to_match_id,
          'previousAuthorityMode', previous_new_authority_mode
        )
      ) returning * into transition_event;
    elsif new_score.authority_mode <> p_initial_authority_mode then
      previous_new_authority_mode := new_score.authority_mode;
      new_epoch := new_score.authority_epoch + 1;
      update public.score_states set authority_epoch = new_epoch,
        authority_mode = p_initial_authority_mode, updated_at = clock_timestamp()
      where id = new_score.id returning * into new_score;
      if p_initial_authority_mode = 'DESIGNATED_PRIMARY' then
        update public.community_assignments set authority_epoch = new_epoch,
          updated_at = clock_timestamp()
        where match_id = p_to_match_id and role = 'DESIGNATED_SCORER'
          and status = 'ACTIVE' and lease_expires_at > clock_timestamp();
      end if;
      insert into public.canonical_score_events (
        event_id, court_id, match_id, revision, authority_epoch, authority_mode,
        command_id, command_type, actor_type, actor_label,
        previous_state, next_state, state_hash, metadata
      ) values (
        p_event_id, p_court_id, p_to_match_id, new_score.revision, new_epoch,
        p_initial_authority_mode, p_action_id || ':activate', 'AUTHORITY_CHANGE',
        p_actor_type, p_actor_label, public.community_score_input_json(new_score),
        public.community_score_input_json(new_score), new_score.state_hash,
        jsonb_build_object(
          'reason', 'match_transition_activation',
          'previousAuthorityMode', previous_new_authority_mode
        )
      );
    end if;
  end if;
  return jsonb_build_object(
    'ok', true, 'duplicate', false, 'eventId', transition_event.id,
    'oldMatchId', p_from_match_id, 'newMatchId', p_to_match_id,
    'match', case when p_to_match_id is null then null else public.community_match_json(p_to_match_id) end,
    'score', case when p_to_match_id is null then null else public.community_score_state_json(new_score) end,
    'community', case when p_to_match_id is null then null else public.community_engagement_json(p_to_match_id, null) end
  );
end;
$$;

create or replace function public.community_status_for_court(p_court_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  court_row public.courts%rowtype;
  score_row public.score_states%rowtype;
  designated_name text;
  assignment_count integer;
  witness_count integer;
  current_authority_mode text;
begin
  select * into court_row from public.courts where id = p_court_id;
  if court_row.id is null then return null; end if;
  if court_row.current_match_id is not null then
    score_row := public.community_reconcile_authority(
      court_row.current_match_id, 'court_status'
    );
  end if;
  select display_name into designated_name
  from public.community_assignments
  where court_id = p_court_id and match_id = court_row.current_match_id
    and role = 'DESIGNATED_SCORER' and status = 'ACTIVE'
    and lease_expires_at > clock_timestamp()
  order by updated_at desc limit 1;
  select count(*)::integer,
    count(*) filter (where role in ('OBSERVER', 'VERIFIED_WITNESS'))::integer
  into assignment_count, witness_count
  from public.community_assignments
  where court_id = p_court_id and match_id = court_row.current_match_id
    and status = 'ACTIVE' and lease_expires_at > clock_timestamp();
  current_authority_mode := score_row.authority_mode;
  return jsonb_build_object(
    'activeDesignatedName', designated_name,
    'activeAssignmentCount', coalesce(assignment_count, 0),
    'activeWitnessCount', coalesce(witness_count, 0),
    'needsScorer', court_row.current_match_id is not null
      and coalesce(current_authority_mode, 'PAUSED_DISPUTE') = 'PAUSED_DISPUTE'
  );
end;
$$;

create or replace function public.community_status_for_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  court_row public.courts%rowtype;
  court_status jsonb;
  statuses jsonb := '[]'::jsonb;
begin
  -- One server RPC reconciles every court in deterministic lock order so a
  -- public event list never trusts lease-backed authority stored before expiry.
  for court_row in
    select * from public.courts
    where event_id = p_event_id
    order by id
  loop
    court_status := public.community_status_for_court(court_row.id);
    statuses := statuses || jsonb_build_array(
      court_status || jsonb_build_object(
        'courtId', court_row.id,
        'matchId', court_row.current_match_id
      )
    );
  end loop;
  return statuses;
end;
$$;

-- Venue-scale admin projection: return every live elevated assignment, only
-- the newest bounded ordinary observers per court, and truthful total counts.
-- Historical/expired rows never enter this operational dashboard DTO.
create or replace function public.community_admin_assignment_summary(
  p_event_id uuid,
  p_observer_limit_per_court integer default 25
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with live_assignments as (
    select assignment.*,
      row_number() over (
        partition by assignment.court_id, assignment.role
        order by assignment.last_seen_at desc, assignment.created_at desc, assignment.id
      ) as role_rank
    from public.community_assignments assignment
    join public.courts court
      on court.id = assignment.court_id
      and court.event_id = p_event_id
      and court.current_match_id = assignment.match_id
    where assignment.event_id = p_event_id
      and assignment.status = 'ACTIVE'
      and assignment.lease_expires_at > statement_timestamp()
  ),
  returned_assignments as (
    select * from live_assignments
    where role <> 'OBSERVER'
      or role_rank <= least(greatest(coalesce(p_observer_limit_per_court, 25), 1), 100)
  ),
  assignment_counts as (
    select court_id,
      count(*)::integer as active_assignment_count,
      count(*) filter (where role = 'OBSERVER')::integer as active_observer_count,
      count(*) filter (where role = 'VERIFIED_WITNESS')::integer as active_verified_witness_count,
      count(*) filter (where role = 'DESIGNATED_SCORER')::integer as active_designated_count
    from live_assignments
    group by court_id
  )
  select jsonb_build_object(
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', assignment.id,
        'event_id', assignment.event_id,
        'court_id', assignment.court_id,
        'match_id', assignment.match_id,
        'role', assignment.role,
        'trust_tier', assignment.trust_tier,
        'status', assignment.status,
        'display_name', assignment.display_name,
        'last_seen_at', assignment.last_seen_at,
        'lease_expires_at', assignment.lease_expires_at,
        'created_at', assignment.created_at
      ) order by assignment.court_id,
        case assignment.role
          when 'DESIGNATED_SCORER' then 0
          when 'VERIFIED_WITNESS' then 1
          else 2
        end,
        assignment.last_seen_at desc,
        assignment.id)
      from returned_assignments assignment
    ), '[]'::jsonb),
    'courtCounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'courtId', court.id,
        'matchId', court.current_match_id,
        'activeAssignmentCount', coalesce(counts.active_assignment_count, 0),
        'activeObserverCount', coalesce(counts.active_observer_count, 0),
        'activeVerifiedWitnessCount', coalesce(counts.active_verified_witness_count, 0),
        'activeDesignatedCount', coalesce(counts.active_designated_count, 0),
        'returnedObserverCount', least(
          coalesce(counts.active_observer_count, 0),
          least(greatest(coalesce(p_observer_limit_per_court, 25), 1), 100)
        )
      ) order by court.court_number, court.id)
      from public.courts court
      left join assignment_counts counts on counts.court_id = court.id
      where court.event_id = p_event_id
    ), '[]'::jsonb)
  );
$$;

create or replace function public.community_resolve_fallback_authority(
  p_match_id uuid,
  p_expected_authority_epoch bigint,
  p_action_id text,
  p_actor_label text default 'Score source fallback'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  score_row public.score_states%rowtype;
  target_mode text;
  verified_count integer;
begin
  select * into score_row from public.score_states where match_id = p_match_id for update;
  if score_row.id is null or score_row.authority_epoch <> p_expected_authority_epoch then
    raise exception 'authority epoch conflict' using errcode = '40001';
  end if;
  if score_row.authority_mode = 'ADMIN_LOCKED' then
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'selectedAuthorityMode', 'ADMIN_LOCKED',
      'match', public.community_match_json(p_match_id),
      'score', public.community_score_state_json(score_row),
      'community', public.community_engagement_json(p_match_id, null)
    );
  end if;
  update public.community_assignments set status = 'EXPIRED', updated_at = clock_timestamp()
  where match_id = p_match_id and status = 'ACTIVE' and lease_expires_at <= clock_timestamp();
  if exists (
    select 1 from public.community_assignments
    where match_id = p_match_id and role = 'DESIGNATED_SCORER'
      and status = 'ACTIVE' and lease_expires_at > clock_timestamp()
  ) then
    target_mode := 'DESIGNATED_PRIMARY';
  else
    select count(*)::integer into verified_count
    from public.community_assignments
    where match_id = p_match_id and role = 'VERIFIED_WITNESS'
      and trust_tier = 'VERIFIED_COURTSIDE' and status = 'ACTIVE'
      and lease_expires_at > clock_timestamp();
    target_mode := case when verified_count >= 3 then 'VERIFIED_CONSENSUS' else 'PAUSED_DISPUTE' end;
  end if;
  return public.community_change_authority(
    p_match_id, target_mode, score_row.authority_epoch,
    p_action_id, 'SYSTEM', p_actor_label
  ) || jsonb_build_object('selectedAuthorityMode', target_mode);
end;
$$;

create or replace function public.community_list_open_disputes(
  p_event_id uuid,
  p_court_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- Admin queue is intentionally bounded to the 200 newest open reviews for
  -- the requested event/court; older evidence remains queryable in the table.
  with all_open_disputes as (
    select *
    from public.score_disputes
    where event_id = p_event_id
      and (p_court_id is null or court_id = p_court_id)
      and status in ('OPEN', 'ACKNOWLEDGED')
  ),
  recent_disputes as (
    select * from all_open_disputes
    order by opened_at desc, id desc
    limit 200
  )
  select jsonb_build_object(
    'disputes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', dispute.id,
        'eventId', dispute.event_id,
        'courtId', dispute.court_id,
        'matchId', dispute.match_id,
        'rallyNumber', dispute.rally_number,
        'baseRevision', dispute.base_revision,
        'status', dispute.status,
        'expectedActionType', dispute.expected_action_type,
        'expectedTeamSide', dispute.expected_team_side,
        'canonicalEventId', dispute.canonical_event_id,
        'resolutionKind', case
          when linked_event.command_type = 'AUTHORITY_CHANGE' and dispute.proposal_eligible
            then 'UNAPPLIED_MAJORITY_PROPOSAL'
          when linked_event.command_type = 'AUTHORITY_CHANGE'
            then 'NO_CONSENSUS_REVIEW'
          else 'POST_CANONICAL_DISSENT'
        end,
        'alreadyApplied', linked_event.command_type is distinct from 'AUTHORITY_CHANGE',
        'differingCount', dispute.differing_count,
        'eligibleVoteCount', dispute.eligible_vote_count,
        'proposalVoteCount', dispute.proposal_vote_count,
        'proposalEligible', dispute.proposal_eligible,
        'voteBreakdown', dispute.vote_breakdown,
        'openedAt', dispute.opened_at,
        'teamAName', coalesce(match.team_a, 'Team A'),
        'teamBName', coalesce(match.team_b, 'Team B')
      ) order by dispute.opened_at desc, dispute.id desc)
      from recent_disputes dispute
      join public.matches match on match.id = dispute.match_id
      left join public.canonical_score_events linked_event on linked_event.id = dispute.canonical_event_id
    ), '[]'::jsonb),
    'totalOpenCount', (select count(*)::integer from all_open_disputes),
    'truncated', (select count(*) > 200 from all_open_disputes),
    'limit', 200
  );
$$;

create or replace function public.community_resolve_dispute(
  p_dispute_id uuid,
  p_outcome text,
  p_resolution text,
  p_canonical_event_id uuid,
  p_expected_revision bigint,
  p_expected_authority_epoch bigint,
  p_actor_label text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  dispute_row public.score_disputes%rowtype;
  score_row public.score_states%rowtype;
  linked_event public.canonical_score_events%rowtype;
  resolving_event public.canonical_score_events%rowtype;
  dismissal_event public.canonical_score_events%rowtype;
  boundary_result jsonb;
  target_mode text;
  is_unapplied_review boolean := false;
begin
  if p_outcome not in ('RESOLVED', 'DISMISSED')
    or p_resolution is null or char_length(btrim(p_resolution)) < 1
    or char_length(p_resolution) > 1000 then
    raise exception 'dispute resolution is invalid' using errcode = '22023';
  end if;
  select * into dispute_row from public.score_disputes where id = p_dispute_id;
  if dispute_row.id is null then
    raise exception 'score dispute not found' using errcode = 'P0002';
  end if;
  select * into score_row from public.score_states where match_id = dispute_row.match_id for update;
  select * into dispute_row from public.score_disputes where id = p_dispute_id for update;
  select * into dismissal_event
  from public.canonical_score_events event
  where event.command_id = 'review-dismissed:' || dispute_row.id::text;
  if dispute_row.status not in ('OPEN', 'ACKNOWLEDGED') then
    return jsonb_build_object(
      'ok', true, 'duplicate', true, 'disputeId', dispute_row.id,
      'status', dispute_row.status, 'resolution', dispute_row.resolution,
      'canonicalEventId', dispute_row.canonical_event_id,
      'eventId', dismissal_event.id,
      'outboxId', (select id from public.canonical_score_outbox where canonical_event_id = dismissal_event.id),
      'match', public.community_match_json(dispute_row.match_id),
      'score', public.community_score_state_json(score_row),
      'community', public.community_engagement_json(dispute_row.match_id, null),
      'resolvedAt', dispute_row.resolved_at
    );
  end if;
  if score_row.revision <> p_expected_revision
    or score_row.authority_epoch <> p_expected_authority_epoch then
    raise exception 'score changed before dispute resolution' using errcode = '40001';
  end if;
  if p_outcome = 'RESOLVED' then
    if p_canonical_event_id is null then
      raise exception 'resolved dispute requires a canonical correction event' using errcode = '23514';
    end if;
    select * into resolving_event
    from public.canonical_score_events where id = p_canonical_event_id;
    if resolving_event.id is null
      or resolving_event.match_id <> dispute_row.match_id
      or resolving_event.revision <> score_row.revision
      or resolving_event.id = dispute_row.canonical_event_id
      or resolving_event.created_at < dispute_row.opened_at then
      raise exception 'canonical correction does not resolve this dispute' using errcode = '23514';
    end if;
  elsif p_canonical_event_id is not null then
    raise exception 'dismissed dispute must not claim a correction event' using errcode = '23514';
  end if;

  select * into linked_event
  from public.canonical_score_events event
  where event.id = dispute_row.canonical_event_id;
  if linked_event.id is null or linked_event.match_id <> dispute_row.match_id then
    raise exception 'dispute is missing its linked canonical event' using errcode = '23514';
  end if;
  is_unapplied_review := linked_event.command_type = 'AUTHORITY_CHANGE';

  if p_outcome = 'DISMISSED' and is_unapplied_review then
    -- Keeping the numeric score on an unapplied review is still a canonical
    -- decision. Advance revision so immutable prior votes no longer disable
    -- witnesses, restore the best live authority, and publish the boundary.
    target_mode := public.community_fallback_mode(dispute_row.match_id);
    boundary_result := public.community_commit_locked_score(
      dispute_row.match_id,
      null,
      'review-dismissed:' || dispute_row.id::text,
      'REVIEW_DISMISSED',
      null,
      'ADMIN',
      p_actor_label,
      score_row.revision,
      score_row.authority_epoch,
      target_mode,
      public.community_score_input_json(score_row),
      jsonb_build_object(
        'source', score_row.source,
        'sourceAvailable', score_row.source_available,
        'sourcePriority', score_row.source_priority,
        'sourcePendingScores', score_row.source_pending_scores,
        'stale', score_row.stale,
        'message', score_row.message,
        'lastApiPollAt', score_row.last_api_poll_at,
        'lastScoreChangeAt', score_row.last_score_change_at
      ),
      jsonb_build_object(
        'communityDisputeId', dispute_row.id,
        'reviewOutcome', 'KEPT_CURRENT_SCORE',
        'forceRevision', true
      )
    );
    select * into dismissal_event
    from public.canonical_score_events event
    where event.id = nullif(boundary_result->>'eventId', '')::uuid;
    select * into score_row
    from public.score_states where match_id = dispute_row.match_id;
    update public.community_assignments set
      authority_epoch = score_row.authority_epoch,
      updated_at = clock_timestamp()
    where match_id = dispute_row.match_id
      and status = 'ACTIVE'
      and lease_expires_at > clock_timestamp();
  end if;

  update public.score_disputes set
    status = p_outcome,
    resolution = left(format('%s: %s', p_actor_label, btrim(p_resolution)), 1000),
    canonical_event_id = coalesce(p_canonical_event_id, dismissal_event.id, canonical_event_id),
    resolved_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = dispute_row.id returning * into dispute_row;
  if p_outcome = 'DISMISSED' and is_unapplied_review then
    insert into public.rally_resolutions (
      event_id, court_id, match_id, rally_number, canonical_event_id, status,
      action_type, team_side, witness_count, confirmed_count, differing_count
    ) values (
      dispute_row.event_id, dispute_row.court_id, dispute_row.match_id,
      dispute_row.rally_number, dismissal_event.id, 'VOIDED',
      dispute_row.expected_action_type, dispute_row.expected_team_side,
      dispute_row.eligible_vote_count, 0, dispute_row.differing_count
    )
    on conflict (match_id, rally_number) do update set
      canonical_event_id = excluded.canonical_event_id,
      status = 'VOIDED',
      witness_count = excluded.witness_count,
      confirmed_count = 0,
      differing_count = excluded.differing_count,
      resolved_at = clock_timestamp(),
      updated_at = clock_timestamp();
  end if;
  update public.rally_resolutions set
    status = case
      when p_outcome = 'RESOLVED' then 'CORRECTED'
      when is_unapplied_review then 'VOIDED'
      when linked_event.command_type = 'REMOVE_POINT' then 'CORRECTED'
      else 'CONFIRMED'
    end,
    canonical_event_id = coalesce(p_canonical_event_id, dismissal_event.id, canonical_event_id),
    updated_at = clock_timestamp()
  where match_id = dispute_row.match_id and rally_number = dispute_row.rally_number;

  if p_outcome = 'RESOLVED'
    and resolving_event.command_type in ('ADD_POINT', 'REMOVE_POINT')
    and resolving_event.team_side in ('A', 'B') then
    update public.contribution_receipts receipt set
      status = case
        when observation.action_type = resolving_event.command_type
          and observation.team_side = resolving_event.team_side
          then 'CONTRIBUTED_TO_CORRECTION'
        else 'DIFFERED'
      end,
      message_code = case
        when observation.action_type = resolving_event.command_type
          and observation.team_side = resolving_event.team_side
          then 'EVIDENCE_HELPED_CORRECTION'
        else 'REVIEW_RESOLVED_DIFFERENTLY'
      end,
      canonical_revision = resolving_event.revision,
      resolved_at = clock_timestamp(), updated_at = clock_timestamp()
    from public.rally_observations observation
    where receipt.observation_id = observation.id
      and observation.match_id = dispute_row.match_id
      and observation.base_revision = dispute_row.base_revision;
  elsif p_outcome = 'DISMISSED' and not is_unapplied_review
    and linked_event.command_type in ('ADD_POINT', 'REMOVE_POINT')
    and linked_event.team_side in ('A', 'B') then
    update public.contribution_receipts receipt set
      status = case
        when observation.action_type = linked_event.command_type
          and observation.team_side = linked_event.team_side then 'CONFIRMED'
        else 'DIFFERED'
      end,
      message_code = case
        when observation.action_type = linked_event.command_type
          and observation.team_side = linked_event.team_side then 'MATCHED_CANONICAL'
        else 'REVIEW_KEPT_CANONICAL'
      end,
      canonical_revision = linked_event.revision,
      resolved_at = clock_timestamp(), updated_at = clock_timestamp()
    from public.rally_observations observation
    where receipt.observation_id = observation.id
      and observation.match_id = dispute_row.match_id
      and observation.base_revision = dispute_row.base_revision;
  else
    update public.contribution_receipts receipt set
      status = case when p_outcome = 'DISMISSED' then 'DIFFERED' else 'LATE' end,
      message_code = case when p_outcome = 'DISMISSED'
        then 'REVIEW_KEPT_CANONICAL' else 'REVIEW_RESOLVED_WITH_FULL_CORRECTION' end,
      canonical_revision = score_row.revision,
      resolved_at = clock_timestamp(), updated_at = clock_timestamp()
    from public.rally_observations observation
    where receipt.observation_id = observation.id
      and observation.match_id = dispute_row.match_id
      and observation.base_revision = dispute_row.base_revision;
  end if;
  return jsonb_build_object(
    'ok', true, 'duplicate', false, 'disputeId', dispute_row.id,
    'matchId', dispute_row.match_id, 'rallyNumber', dispute_row.rally_number,
    'status', dispute_row.status, 'resolution', dispute_row.resolution,
    'canonicalEventId', dispute_row.canonical_event_id,
    'eventId', dismissal_event.id,
    'outboxId', (select id from public.canonical_score_outbox where canonical_event_id = dismissal_event.id),
    'match', public.community_match_json(dispute_row.match_id),
    'score', public.community_score_state_json(score_row),
    'community', public.community_engagement_json(dispute_row.match_id, null),
    'resolvedAt', dispute_row.resolved_at
  );
end;
$$;

-- Apply an unapplied strict-majority proposal and close its dispute in one database
-- transaction. This is the only auto-apply path: it shares the canonical SQL
-- reducer with designated scoring, commits the score/outbox, and resolves all
-- receipts without a split TypeScript read/modify/write window.
create or replace function public.community_apply_dispute_proposal(
  p_dispute_id uuid,
  p_action_id uuid,
  p_expected_revision bigint,
  p_expected_authority_epoch bigint,
  p_actor_label text default 'Fan scoring admin'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  dispute_row public.score_disputes%rowtype;
  court_row public.courts%rowtype;
  score_row public.score_states%rowtype;
  linked_event public.canonical_score_events%rowtype;
  correction_event public.canonical_score_events%rowtype;
  next_state jsonb;
  commit_result jsonb;
  resolution_result jsonb;
  requested_command_id text := p_action_id::text;
begin
  select * into dispute_row
  from public.score_disputes where id = p_dispute_id;
  if dispute_row.id is null then
    raise exception 'score dispute not found' using errcode = 'P0002';
  end if;
  select * into court_row
  from public.courts where id = dispute_row.court_id for update;
  select * into score_row
  from public.score_states where match_id = dispute_row.match_id for update;
  select * into dispute_row
  from public.score_disputes where id = p_dispute_id for update;
  if court_row.id is null
    or court_row.event_id <> dispute_row.event_id
    or court_row.current_match_id <> dispute_row.match_id
    or score_row.id is null
    or score_row.court_id <> court_row.id then
    raise exception 'score dispute scope is no longer current' using errcode = '55000';
  end if;

  select * into correction_event
  from public.canonical_score_events event
  where event.match_id = dispute_row.match_id
    and (dispute_row.status = 'RESOLVED' or event.id <> dispute_row.canonical_event_id)
    and event.command_id = requested_command_id
  order by event.created_at desc
  limit 1;

  if dispute_row.status not in ('OPEN', 'ACKNOWLEDGED') then
    if dispute_row.status = 'RESOLVED'
      and correction_event.id is not null
      and correction_event.command_id = requested_command_id then
      return jsonb_build_object(
        'ok', true, 'duplicate', true,
        'disputeId', dispute_row.id, 'status', dispute_row.status,
        'resolution', dispute_row.resolution,
        'canonicalEventId', correction_event.id,
        'eventId', correction_event.id,
        'outboxId', (select id from public.canonical_score_outbox where canonical_event_id = correction_event.id),
        'match', public.community_match_json(dispute_row.match_id),
        'score', public.community_score_state_json(score_row),
        'community', public.community_engagement_json(dispute_row.match_id, null),
        'resolvedAt', dispute_row.resolved_at
      );
    end if;
    raise exception 'score dispute is no longer open' using errcode = '55000';
  end if;

  select * into linked_event
  from public.canonical_score_events where id = dispute_row.canonical_event_id;
  if linked_event.id is null
    or linked_event.match_id <> dispute_row.match_id
    or linked_event.command_type <> 'AUTHORITY_CHANGE'
    or dispute_row.proposal_eligible is not true then
    raise exception 'only an unapplied strict-majority proposal can be auto-applied' using errcode = '23514';
  end if;
  if score_row.revision <> p_expected_revision
    or score_row.authority_epoch <> p_expected_authority_epoch then
    raise exception 'score changed before dispute application' using errcode = '40001';
  end if;

  if correction_event.id is null then
    next_state := public.community_reduce_score_action(
      public.community_score_input_json(score_row),
      jsonb_build_object(
        'type', dispute_row.expected_action_type,
        'team', dispute_row.expected_team_side
      ),
      (select format from public.matches where id = dispute_row.match_id)
    );
    commit_result := public.community_commit_locked_score(
      dispute_row.match_id,
      null,
      requested_command_id,
      dispute_row.expected_action_type,
      dispute_row.expected_team_side,
      'ADMIN',
      p_actor_label,
      score_row.revision,
      score_row.authority_epoch,
      'ADMIN_LOCKED',
      next_state,
      jsonb_build_object(
        'source', 'override',
        'sourceAvailable', false,
        'sourcePriority', 'override',
        'sourcePendingScores', '[]'::jsonb,
        'stale', false,
        'message', format('Admin correction for community review on Rally %s', dispute_row.rally_number),
        'lastApiPollAt', score_row.last_api_poll_at,
        'lastScoreChangeAt', clock_timestamp()
      ),
      jsonb_build_object(
        'communityDisputeId', dispute_row.id,
        'rallyNumber', dispute_row.rally_number,
        'baseRevision', dispute_row.base_revision,
        'reducer', 'community_reduce_score_action'
      )
    );
    select * into correction_event
    from public.canonical_score_events
    where id = nullif(commit_result->>'eventId', '')::uuid;
  end if;

  if correction_event.id is null
    or correction_event.match_id <> dispute_row.match_id
    or correction_event.command_type <> dispute_row.expected_action_type
    or correction_event.team_side <> dispute_row.expected_team_side then
    raise exception 'canonical dispute correction could not be verified' using errcode = '23514';
  end if;
  select * into score_row
  from public.score_states where match_id = dispute_row.match_id;
  resolution_result := public.community_resolve_dispute(
    dispute_row.id,
    'RESOLVED',
    format(
      '%s for Team %s applied from unapplied Rally %s strict-majority proposal.',
      dispute_row.expected_action_type,
      dispute_row.expected_team_side,
      dispute_row.rally_number
    ),
    correction_event.id,
    score_row.revision,
    score_row.authority_epoch,
    p_actor_label
  );
  return resolution_result || jsonb_build_object(
    'eventId', correction_event.id,
    'outboxId', (select id from public.canonical_score_outbox where canonical_event_id = correction_event.id),
    'match', public.community_match_json(dispute_row.match_id),
    'score', public.community_score_state_json(score_row),
    'community', public.community_engagement_json(dispute_row.match_id, null)
  );
end;
$$;

-- PostgreSQL grants EXECUTE on functions to PUBLIC by default. Revoke every
-- community function explicitly; only the server-side service role may cross
-- this boundary.
revoke all on function public.community_reject_immutable_mutation() from public, anon, authenticated;
revoke all on function public.community_guard_receipt_review_history() from public, anon, authenticated;
revoke all on function public.community_normalize_score_state(jsonb) from public, anon, authenticated;
revoke all on function public.community_score_state_json(public.score_states) from public, anon, authenticated;
revoke all on function public.community_score_input_json(public.score_states) from public, anon, authenticated;
revoke all on function public.community_score_hash(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.community_match_json(uuid) from public, anon, authenticated;
revoke all on function public.community_assignment_json(public.community_assignments) from public, anon, authenticated;
revoke all on function public.community_receipt_message(text, integer) from public, anon, authenticated;
revoke all on function public.community_receipt_json(public.contribution_receipts) from public, anon, authenticated;
revoke all on function public.community_engagement_json(uuid, uuid) from public, anon, authenticated;
revoke all on function public.community_session_response(uuid, boolean, uuid, uuid) from public, anon, authenticated;
revoke all on function public.community_fallback_mode(uuid) from public, anon, authenticated;
revoke all on function public.community_reconcile_authority(uuid, text) from public, anon, authenticated;
revoke all on function public.community_reduce_score_action(jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.community_commit_locked_score(uuid, uuid, text, text, text, text, text, bigint, bigint, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.community_ensure_score_projection(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.community_consume_admission_quota(text, text) from public, anon, authenticated;
revoke all on function public.community_join_assignment(text, integer, text, text, text, text, text, text, integer) from public, anon, authenticated;
revoke all on function public.community_create_trusted_assignment(uuid, uuid, uuid, text, text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.community_session_snapshot(text) from public, anon, authenticated;
revoke all on function public.community_heartbeat_assignment(text, integer) from public, anon, authenticated;
revoke all on function public.community_submit_observation(text, text, bigint, text, text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.community_submit_scorer_command(text, text, bigint, jsonb) from public, anon, authenticated;
revoke all on function public.community_commit_trusted_score(uuid, uuid, uuid, text, text, text, text, bigint, bigint, jsonb, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.community_mark_score_outbox(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.community_publish_score_outbox(uuid, bigint, jsonb, text, boolean) from public, anon, authenticated;
revoke all on function public.community_claim_score_outbox(text, integer, integer) from public, anon, authenticated;
revoke all on function public.community_end_assignment_internal(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.community_release_assignment(text, text) from public, anon, authenticated;
revoke all on function public.community_admin_end_assignment(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.community_verify_assignment(uuid, text, text) from public, anon, authenticated;
revoke all on function public.community_promote_assignment(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.community_change_authority(uuid, text, bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.community_create_join_grant(uuid, uuid, uuid, uuid, text, text, text, integer, timestamptz, text) from public, anon, authenticated;
revoke all on function public.community_transition_match(uuid, uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.community_status_for_court(uuid) from public, anon, authenticated;
revoke all on function public.community_status_for_event(uuid) from public, anon, authenticated;
revoke all on function public.community_admin_assignment_summary(uuid, integer) from public, anon, authenticated;
revoke all on function public.community_resolve_fallback_authority(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function public.community_list_open_disputes(uuid, uuid) from public, anon, authenticated;
revoke all on function public.community_resolve_dispute(uuid, text, text, uuid, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.community_apply_dispute_proposal(uuid, uuid, bigint, bigint, text) from public, anon, authenticated;

grant execute on function public.community_consume_admission_quota(text, text) to service_role;
grant execute on function public.community_join_assignment(text, integer, text, text, text, text, text, text, integer) to service_role;
grant execute on function public.community_reconcile_authority(uuid, text) to service_role;
grant execute on function public.community_create_trusted_assignment(uuid, uuid, uuid, text, text, text, text, integer, text, text) to service_role;
grant execute on function public.community_session_snapshot(text) to service_role;
grant execute on function public.community_heartbeat_assignment(text, integer) to service_role;
grant execute on function public.community_submit_observation(text, text, bigint, text, text, bigint, bigint) to service_role;
grant execute on function public.community_submit_scorer_command(text, text, bigint, jsonb) to service_role;
grant execute on function public.community_commit_trusted_score(uuid, uuid, uuid, text, text, text, text, bigint, bigint, jsonb, text, text, jsonb, jsonb) to service_role;
grant execute on function public.community_mark_score_outbox(uuid, bigint, text, text) to service_role;
grant execute on function public.community_publish_score_outbox(uuid, bigint, jsonb, text, boolean) to service_role;
grant execute on function public.community_claim_score_outbox(text, integer, integer) to service_role;
grant execute on function public.community_release_assignment(text, text) to service_role;
grant execute on function public.community_admin_end_assignment(uuid, text, text, text) to service_role;
grant execute on function public.community_verify_assignment(uuid, text, text) to service_role;
grant execute on function public.community_promote_assignment(uuid, bigint, text, text) to service_role;
grant execute on function public.community_change_authority(uuid, text, bigint, text, text, text) to service_role;
grant execute on function public.community_create_join_grant(uuid, uuid, uuid, uuid, text, text, text, integer, timestamptz, text) to service_role;
grant execute on function public.community_transition_match(uuid, uuid, uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.community_status_for_court(uuid) to service_role;
grant execute on function public.community_status_for_event(uuid) to service_role;
grant execute on function public.community_admin_assignment_summary(uuid, integer) to service_role;
grant execute on function public.community_resolve_fallback_authority(uuid, bigint, text, text) to service_role;
grant execute on function public.community_list_open_disputes(uuid, uuid) to service_role;
grant execute on function public.community_resolve_dispute(uuid, text, text, uuid, bigint, bigint, text) to service_role;
grant execute on function public.community_apply_dispute_proposal(uuid, uuid, bigint, bigint, text) to service_role;
