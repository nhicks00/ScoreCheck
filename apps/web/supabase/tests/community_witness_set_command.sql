-- Focused executable checks for canonical set selection.
-- Run after local migrations:
--   docker exec -i supabase_db_web psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f /dev/stdin < supabase/tests/community_witness_set_command.sql

do $canonical_set_command$
declare
  test_event_id uuid := gen_random_uuid();
  test_match_id uuid := gen_random_uuid();
  test_court_id uuid := gen_random_uuid();
  designated_assignment_id uuid := gen_random_uuid();
  observer_assignment_id uuid := gen_random_uuid();
  designated_session text;
  observer_session text;
  first_action_id uuid := gen_random_uuid();
  result jsonb;
  observer_snapshot jsonb;
  score_row public.score_states%rowtype;
  event_row public.canonical_score_events%rowtype;
  organizer_state jsonb;
begin
  update public.events set is_active = false where is_active = true;
  designated_session := encode(extensions.digest(
    convert_to('canonical-set-designated:' || test_event_id::text, 'UTF8'), 'sha256'
  ), 'hex');
  observer_session := encode(extensions.digest(
    convert_to('canonical-set-observer:' || test_event_id::text, 'UTF8'), 'sha256'
  ), 'hex');

  insert into public.events (id, name, status, slug, is_active)
  values (
    test_event_id, 'Canonical set command test', 'active',
    'canonical-set-' || test_event_id::text, true
  );
  insert into public.matches (
    id, event_id, external_match_id, source_type, status,
    team_a, team_b, format
  ) values (
    test_match_id, test_event_id, 'canonical-set-match', 'manual', 'active',
    'Alpha', 'Bravo',
    '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    test_court_id, test_event_id, 1, 'Canonical Set Court', test_match_id,
    'manual', 'live', false, true, 'canonical_set_preview', 'canonical_set_program'
  );
  score_row := public.community_ensure_score_projection(
    test_event_id, test_court_id, test_match_id, 'DESIGNATED_PRIMARY'
  );

  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, device_token_hash,
    display_name, role, trust_tier, status, authority_epoch,
    lease_expires_at, last_seen_at
  ) values
    (
      designated_assignment_id, test_event_id, test_court_id, test_match_id,
      designated_session,
      encode(extensions.digest(convert_to('canonical-set-designated-device:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      'Designated scorer', 'DESIGNATED_SCORER', 'VERIFIED_COURTSIDE', 'ACTIVE',
      score_row.authority_epoch, clock_timestamp() + interval '5 minutes', clock_timestamp()
    ),
    (
      observer_assignment_id, test_event_id, test_court_id, test_match_id,
      observer_session,
      encode(extensions.digest(convert_to('canonical-set-observer-device:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      'Ordinary witness', 'OBSERVER', 'REMOTE', 'ACTIVE',
      score_row.authority_epoch, clock_timestamp() + interval '5 minutes', clock_timestamp()
    );

  result := public.community_submit_scorer_command(
    designated_session,
    first_action_id::text,
    score_row.revision,
    '{"type":"SET_CURRENT_SET","set":2}'::jsonb
  );
  if (result->'score'->>'currentSet')::integer <> 2
    or (result->'score'->>'revision')::bigint <> score_row.revision + 1 then
    raise exception 'designated set command did not commit canonical set 2: %', result;
  end if;

  select * into event_row
  from public.canonical_score_events where command_id = first_action_id::text;
  if event_row.command_type <> 'SET_CURRENT_SET'
    or event_row.assignment_id <> designated_assignment_id
    or event_row.actor_type <> 'COMMUNITY_SCORER'
    or (event_row.previous_state->>'currentSet')::integer <> 1
    or (event_row.next_state->>'currentSet')::integer <> 2
    or (event_row.metadata #>> '{setCorrection,reason}') <> 'OFFICIAL_SET_SELECTION' then
    raise exception 'designated set correction was not fully audited: %', event_row;
  end if;

  observer_snapshot := public.community_session_snapshot(observer_session);
  if (observer_snapshot->'score'->>'currentSet')::integer <> 2 then
    raise exception 'ordinary witness received a private/noncanonical set: %', observer_snapshot;
  end if;

  result := public.community_submit_scorer_command(
    designated_session,
    first_action_id::text,
    score_row.revision,
    '{"type":"SET_CURRENT_SET","set":2}'::jsonb
  );
  if (result->>'duplicate')::boolean is not true
    or (result->'score'->>'currentSet')::integer <> 2 then
    raise exception 'set command retry was not idempotent: %', result;
  end if;

  begin
    perform public.community_submit_scorer_command(
      designated_session,
      gen_random_uuid()::text,
      score_row.revision,
      '{"type":"SET_CURRENT_SET","set":3}'::jsonb
    );
    raise exception 'stale set correction revision was accepted';
  exception when sqlstate '40001' then null;
  end;

  begin
    perform public.community_submit_scorer_command(
      observer_session,
      gen_random_uuid()::text,
      score_row.revision + 1,
      '{"type":"SET_CURRENT_SET","set":3}'::jsonb
    );
    raise exception 'ordinary witness changed the canonical set';
  exception when sqlstate '28000' then null;
  end;

  begin
    perform public.community_submit_scorer_command(
      designated_session,
      gen_random_uuid()::text,
      score_row.revision + 1,
      '{"type":"SET_CURRENT_SET","set":4}'::jsonb
    );
    raise exception 'set correction exceeded match bestOf';
  exception when sqlstate '23514' then null;
  end;

  update public.matches set status = 'completed' where id = test_match_id;
  begin
    perform public.community_submit_scorer_command(
      designated_session,
      gen_random_uuid()::text,
      score_row.revision + 1,
      '{"type":"SET_CURRENT_SET","set":3}'::jsonb
    );
    raise exception 'closed match accepted a set correction';
  exception when sqlstate '23514' then null;
  end;
  update public.matches set status = 'active' where id = test_match_id;

  update public.community_assignments
  set authority_epoch = authority_epoch + 1
  where id = designated_assignment_id;
  begin
    perform public.community_submit_scorer_command(
      designated_session,
      gen_random_uuid()::text,
      score_row.revision + 1,
      '{"type":"SET_CURRENT_SET","set":3}'::jsonb
    );
    raise exception 'assignment without current authority changed the set';
  exception when sqlstate '40001' then null;
  end;
  update public.community_assignments
  set authority_epoch = score_row.authority_epoch
  where id = designated_assignment_id;

  select * into score_row from public.score_states where match_id = test_match_id;
  organizer_state := public.community_score_input_json(score_row)
    || jsonb_build_object('currentSet', 3);
  result := public.community_commit_trusted_score(
    test_event_id,
    test_court_id,
    test_match_id,
    gen_random_uuid()::text,
    'ADMIN',
    'Authorized organizer',
    'ADMIN_LOCKED',
    score_row.revision,
    score_row.authority_epoch,
    organizer_state,
    'SET_CURRENT_SET',
    null,
    jsonb_build_object(
      'source', 'override', 'sourceAvailable', false,
      'sourcePriority', 'override', 'sourcePendingScores', '[]'::jsonb,
      'stale', false, 'message', 'Organizer set correction'
    ),
    '{"adminAction":"set-current-set"}'::jsonb
  );
  if (result->'score'->>'currentSet')::integer <> 3
    or not exists (
      select 1 from public.canonical_score_events event
      where event.id = (result->>'eventId')::uuid
        and event.command_type = 'SET_CURRENT_SET'
        and event.actor_type = 'ADMIN'
        and event.metadata #>> '{setCorrection,reason}' = 'OFFICIAL_SET_SELECTION'
    ) then
    raise exception 'authorized organizer set correction was not canonical and audited: %', result;
  end if;

  select * into score_row from public.score_states where match_id = test_match_id;
  begin
    perform public.community_commit_trusted_score(
      test_event_id, test_court_id, test_match_id, gen_random_uuid()::text,
      'SYSTEM', 'Unauthorized trusted actor', 'ADMIN_LOCKED',
      score_row.revision, score_row.authority_epoch,
      public.community_score_input_json(score_row) || jsonb_build_object('currentSet', 2),
      'SET_CURRENT_SET', null,
      jsonb_build_object(
        'source', 'override', 'sourceAvailable', false,
        'sourcePriority', 'override', 'sourcePendingScores', '[]'::jsonb,
        'stale', false, 'message', null
      ),
      '{}'::jsonb
    );
    raise exception 'non-organizer trusted actor changed the current set';
  exception when sqlstate '28000' then null;
  end;
end;
$canonical_set_command$;
