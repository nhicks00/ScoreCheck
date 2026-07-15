-- Canonical current-set correction for community scoring.
--
-- A set choice is an official score mutation, never a viewer-local preference.
-- It uses the existing designated/admin commit transaction so every session
-- observes the same revisioned state and every effective correction is audited.

do $command_constraint$
declare
  existing_constraint record;
begin
  for existing_constraint in
    select constraint_row.conname
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.canonical_score_events'::regclass
      and constraint_row.contype = 'c'
      and pg_get_constraintdef(constraint_row.oid) like '%command_type%'
  loop
    execute format(
      'alter table public.canonical_score_events drop constraint %I',
      existing_constraint.conname
    );
  end loop;

  alter table public.canonical_score_events
    add constraint canonical_score_events_command_type_check check (command_type in (
      'ADD_POINT', 'REMOVE_POINT', 'CORRECT_SCORE', 'COMPLETE_SET',
      'COMPLETE_MATCH', 'SET_SERVE', 'SET_CURRENT_SET', 'AUTHORITY_CHANGE',
      'ASSIGNMENT_PROMOTED', 'ASSIGNMENT_RELEASED', 'MATCH_TRANSITION',
      'REVIEW_DISMISSED'
    ));
end
$command_constraint$;

create or replace function public.community_select_current_set(
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
  target_set integer;
  best_of integer;
  format_value jsonb := coalesce(p_format, '{}'::jsonb);
begin
  if p_action is null or jsonb_typeof(p_action) <> 'object'
    or p_action->>'type' <> 'SET_CURRENT_SET'
    or not (p_action ? 'set')
    or jsonb_typeof(p_action->'set') <> 'number'
    or (p_action - array['type', 'set']) <> '{}'::jsonb then
    raise exception 'invalid SET_CURRENT_SET payload' using errcode = '22023';
  end if;
  if jsonb_typeof(format_value) <> 'object' then
    raise exception 'match format must be an object' using errcode = '22023';
  end if;
  if format_value ? 'bestOf' and format_value->'bestOf' <> 'null'::jsonb
    and jsonb_typeof(format_value->'bestOf') <> 'number' then
    raise exception 'match format bestOf must be an integer' using errcode = '22023';
  end if;

  target_set := (p_action->>'set')::integer;
  best_of := coalesce((format_value->>'bestOf')::integer, 3);
  if best_of < 1 or best_of > 99 then
    raise exception 'match format bestOf is outside the allowed range' using errcode = '22023';
  end if;
  if target_set < 1 or target_set > best_of then
    raise exception 'set % is outside this best-of-% match', target_set, best_of
      using errcode = '23514';
  end if;
  if previous->>'status' = 'Final' then
    raise exception 'a completed match cannot change its current set' using errcode = '23514';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(previous->'setScores') completed_set
    where completed_set->>'setNumber' = target_set::text
      and completed_set->>'isComplete' = 'true'
  ) then
    raise exception 'set % is already complete', target_set using errcode = '23514';
  end if;

  -- Deliberately change only the canonical set number. Point totals, set wins,
  -- active status, service, and completed-set history are separate facts and
  -- must never be guessed merely because a scorer joined late.
  return public.community_normalize_score_state(
    previous || jsonb_build_object('currentSet', target_set)
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'set and match format fields must be integers' using errcode = '22023';
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
  match_row public.matches%rowtype;
  action_type text := p_action->>'type';
  team_side text := p_action->>'team';
  next_state jsonb;
  command_metadata jsonb := '{}'::jsonb;
begin
  select * into assignment_row
  from public.community_assignments where session_token_hash = p_session_token_hash;
  if assignment_row.id is null then
    raise exception 'community assignment not found' using errcode = 'P0002';
  end if;
  select * into score_row from public.score_states where match_id = assignment_row.match_id for update;
  select * into assignment_row from public.community_assignments where id = assignment_row.id for update;
  if score_row.id is null then
    raise exception 'canonical score not found' using errcode = 'P0002';
  end if;
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

  select * into match_row from public.matches where id = assignment_row.match_id;
  if match_row.id is null then
    raise exception 'community match not found' using errcode = 'P0002';
  end if;
  if lower(btrim(coalesce(match_row.status, ''))) in (
    'final', 'finished', 'completed', 'complete', 'closed', 'ended',
    'cancelled', 'canceled'
  ) then
    raise exception 'completed or closed matches cannot accept score commands' using errcode = '23514';
  end if;

  if action_type = 'SET_CURRENT_SET' then
    next_state := public.community_select_current_set(
      public.community_score_input_json(score_row), p_action, match_row.format
    );
    command_metadata := jsonb_build_object(
      'setCorrection', jsonb_build_object(
        'previousCurrentSet', score_row.current_set,
        'selectedCurrentSet', (next_state->>'currentSet')::integer,
        'reason', 'OFFICIAL_SET_SELECTION'
      )
    );
  else
    next_state := public.community_reduce_score_action(
      public.community_score_input_json(score_row), p_action, match_row.format
    );
  end if;

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
    command_metadata
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
  match_row public.matches%rowtype;
  score_row public.score_states%rowtype;
  next_state jsonb := p_state;
  command_metadata jsonb := coalesce(p_metadata, '{}'::jsonb);
  commit_result jsonb;
begin
  if p_actor_type not in ('ADMIN', 'PROVIDER', 'SYSTEM') then
    raise exception 'trusted actor type is invalid' using errcode = '22023';
  end if;
  if p_actor_type = 'PROVIDER' and p_authority_mode <> 'PROVIDER_PRIMARY' then
    raise exception 'provider commits require PROVIDER_PRIMARY authority' using errcode = '23514';
  end if;
  if p_command_type not in (
    'ADD_POINT', 'REMOVE_POINT', 'CORRECT_SCORE', 'COMPLETE_SET',
    'COMPLETE_MATCH', 'SET_SERVE', 'SET_CURRENT_SET'
  )
    or (p_team_side is not null and p_team_side not in ('A', 'B'))
    or (p_command_type in ('ADD_POINT', 'REMOVE_POINT', 'SET_SERVE') and p_team_side is null)
    or (p_command_type = 'SET_CURRENT_SET' and p_team_side is not null) then
    raise exception 'trusted command semantics are invalid' using errcode = '22023';
  end if;
  select * into court_row from public.courts where id = p_court_id for update;
  if court_row.id is null or court_row.event_id <> p_event_id or court_row.current_match_id <> p_match_id then
    raise exception 'trusted score scope is not current' using errcode = '23514';
  end if;
  select * into match_row from public.matches where id = p_match_id;
  if match_row.id is null or match_row.event_id <> p_event_id then
    raise exception 'trusted match scope is invalid' using errcode = '23514';
  end if;
  score_row := public.community_ensure_score_projection(
    p_event_id, p_court_id, p_match_id, p_authority_mode
  );
  if p_actor_type = 'PROVIDER' and score_row.authority_mode = 'ADMIN_LOCKED' then
    raise exception 'admin lock blocks provider score commits' using errcode = '55000';
  end if;

  if p_command_type = 'SET_CURRENT_SET' then
    if p_actor_type <> 'ADMIN' then
      raise exception 'only an authorized organizer can issue a trusted set correction' using errcode = '28000';
    end if;
    if p_expected_revision is null then
      raise exception 'set correction requires an expected revision' using errcode = '22023';
    end if;
    if court_row.scoring_open is not true or court_row.frozen is true then
      raise exception 'closed or frozen courts cannot change the current set' using errcode = '23514';
    end if;
    if lower(btrim(coalesce(match_row.status, ''))) in (
      'final', 'finished', 'completed', 'complete', 'closed', 'ended',
      'cancelled', 'canceled'
    ) then
      raise exception 'completed or closed matches cannot change the current set' using errcode = '23514';
    end if;
    next_state := public.community_select_current_set(
      public.community_score_input_json(score_row),
      jsonb_build_object('type', 'SET_CURRENT_SET', 'set', p_state->'currentSet'),
      match_row.format
    );
    if public.community_normalize_score_state(p_state) <> next_state then
      raise exception 'SET_CURRENT_SET cannot mutate other score fields' using errcode = '23514';
    end if;
    command_metadata := command_metadata || jsonb_build_object(
      'setCorrection', jsonb_build_object(
        'previousCurrentSet', score_row.current_set,
        'selectedCurrentSet', (next_state->>'currentSet')::integer,
        'reason', 'OFFICIAL_SET_SELECTION'
      )
    );
  end if;

  commit_result := public.community_commit_locked_score(
    p_match_id, null, p_action_id, p_command_type, p_team_side,
    p_actor_type, p_actor_label, p_expected_revision, p_expected_authority_epoch,
    p_authority_mode, next_state, p_projection_metadata, command_metadata
  );
  -- An admin override takes an API-controlled court into hybrid mode in the
  -- same transaction as the canonical score event. A rejected score therefore
  -- cannot leave the court mode partially changed.
  if p_actor_type = 'ADMIN' and court_row.mode = 'api' then
    update public.courts
    set mode = 'hybrid', updated_at = clock_timestamp()
    where id = court_row.id;
  end if;
  return commit_result;
end;
$$;

revoke all on function public.community_select_current_set(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.community_submit_scorer_command(text, text, bigint, jsonb)
  from public, anon, authenticated;
revoke all on function public.community_commit_trusted_score(
  uuid, uuid, uuid, text, text, text, text, bigint, bigint, jsonb, text, text, jsonb, jsonb
) from public, anon, authenticated;

grant execute on function public.community_select_current_set(jsonb, jsonb, jsonb)
  to service_role;
grant execute on function public.community_submit_scorer_command(text, text, bigint, jsonb)
  to service_role;
grant execute on function public.community_commit_trusted_score(
  uuid, uuid, uuid, text, text, text, text, bigint, bigint, jsonb, text, text, jsonb, jsonb
) to service_role;

comment on function public.community_select_current_set(jsonb, jsonb, jsonb) is
  'Validates one official set correction against canonical state and match format without inferring any other score fact.';
