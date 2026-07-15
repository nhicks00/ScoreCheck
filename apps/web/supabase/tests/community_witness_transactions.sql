-- Transactional contract checks for lease reconciliation and atomic outbox
-- publication. All fixtures are rolled back after assertions.

begin;

do $$
declare
  test_event_id uuid := gen_random_uuid();
  test_match_id uuid := gen_random_uuid();
  next_match_id uuid := gen_random_uuid();
  test_court_id uuid := gen_random_uuid();
  status_result jsonb;
  event_status_result jsonb;
  score_row public.score_states%rowtype;
  expired_designated_id uuid := gen_random_uuid();
  expired_witness_id uuid := gen_random_uuid();
  active_observer_id uuid := gen_random_uuid();
  engagement_result jsonb;
  transition_result jsonb;
  release_result jsonb;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (test_event_id, 'Community reconciliation test', 'active', 'community-reconcile-' || test_event_id::text, true);
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values (
    test_match_id, test_event_id, 'reconcile-match', 'manual', 'active',
    'Alpha', 'Bravo', '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    test_court_id, test_event_id, 1, 'Reconciliation Court', test_match_id,
    'manual', 'live', false, true, 'reconcile_preview', 'reconcile_program'
  );

  score_row := public.community_ensure_score_projection(
    test_event_id, test_court_id, test_match_id, 'DESIGNATED_PRIMARY'
  );
  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values (
    expired_designated_id, test_event_id, test_court_id, test_match_id,
    repeat('a', 64), 'Expired scorer', 'DESIGNATED_SCORER',
    'VERIFIED_COURTSIDE', 'ACTIVE', score_row.authority_epoch,
    clock_timestamp() - interval '1 second'
  );

  status_result := public.community_status_for_court(test_court_id);
  select * into score_row from public.score_states where match_id = test_match_id;
  if score_row.authority_mode <> 'PAUSED_DISPUTE'
    or (status_result->>'needsScorer')::boolean is not true
    or (select status from public.community_assignments where id = expired_designated_id) <> 'EXPIRED'
    or not exists (
      select 1 from public.canonical_score_events event
      where event.match_id = test_match_id
        and event.authority_epoch = score_row.authority_epoch
        and event.metadata->>'previousAuthorityMode' = 'DESIGNATED_PRIMARY'
        and event.metadata->>'selectedAuthorityMode' = 'PAUSED_DISPUTE'
    ) then
    raise exception 'expired designated authority was reported as covered: score=%, status=%', score_row, status_result;
  end if;
  event_status_result := public.community_status_for_event(test_event_id);
  if event_status_result->0->>'courtId' <> test_court_id::text
    or (event_status_result->0->>'needsScorer')::boolean is not true
    or event_status_result->0->>'activeDesignatedName' is not null then
    raise exception 'event status list reported expired designated coverage: %', event_status_result;
  end if;

  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values
    (gen_random_uuid(), test_event_id, test_court_id, test_match_id,
      repeat('b', 64), 'Witness one', 'VERIFIED_WITNESS', 'VERIFIED_COURTSIDE',
      'ACTIVE', score_row.authority_epoch + 1, clock_timestamp() + interval '5 minutes'),
    (gen_random_uuid(), test_event_id, test_court_id, test_match_id,
      repeat('c', 64), 'Witness two', 'VERIFIED_WITNESS', 'VERIFIED_COURTSIDE',
      'ACTIVE', score_row.authority_epoch + 1, clock_timestamp() + interval '5 minutes'),
    (expired_witness_id, test_event_id, test_court_id, test_match_id,
      repeat('d', 64), 'Expired witness', 'VERIFIED_WITNESS', 'VERIFIED_COURTSIDE',
      'ACTIVE', score_row.authority_epoch + 1, clock_timestamp() - interval '1 second');
  update public.score_states set
    authority_mode = 'VERIFIED_CONSENSUS',
    authority_epoch = score_row.authority_epoch + 1
  where match_id = test_match_id;

  status_result := public.community_status_for_court(test_court_id);
  select * into score_row from public.score_states where match_id = test_match_id;
  if score_row.authority_mode <> 'PAUSED_DISPUTE'
    or (status_result->>'needsScorer')::boolean is not true
    or (status_result->>'activeWitnessCount')::integer <> 2
    or (select status from public.community_assignments where id = expired_witness_id) <> 'EXPIRED'
    or not exists (
      select 1 from public.canonical_score_events event
      where event.match_id = test_match_id
        and event.authority_epoch = score_row.authority_epoch
        and event.metadata->>'previousAuthorityMode' = 'VERIFIED_CONSENSUS'
        and event.metadata->>'selectedAuthorityMode' = 'PAUSED_DISPUTE'
    ) then
    raise exception 'lost witness quorum was reported as covered: score=%, status=%', score_row, status_result;
  end if;
  event_status_result := public.community_status_for_event(test_event_id);
  if (event_status_result->0->>'needsScorer')::boolean is not true
    or (event_status_result->0->>'activeWitnessCount')::integer <> 2 then
    raise exception 'event status list reported lost quorum as covered: %', event_status_result;
  end if;

  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values (
    active_observer_id, test_event_id, test_court_id, test_match_id,
    repeat('e', 64), 'Active observer', 'OBSERVER', 'REMOTE',
    'ACTIVE', score_row.authority_epoch, clock_timestamp() + interval '5 minutes'
  );
  engagement_result := public.community_engagement_json(test_match_id, active_observer_id);
  if (engagement_result->>'hasContributedToCurrentRevision')::boolean is not false then
    raise exception 'fresh observer was incorrectly marked contributed: %', engagement_result;
  end if;
  insert into public.rally_observations (
    event_id, court_id, match_id, assignment_id, client_action_id,
    base_revision, rally_number, action_type, team_side
  ) values (
    test_event_id, test_court_id, test_match_id, active_observer_id,
    gen_random_uuid()::text, score_row.revision, score_row.current_rally_number + 1,
    'ADD_POINT', 'A'
  );
  engagement_result := public.community_engagement_json(test_match_id, active_observer_id);
  if (engagement_result->>'hasContributedToCurrentRevision')::boolean is not true then
    raise exception 'current-revision contribution was not exposed: %', engagement_result;
  end if;

  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values (
    next_match_id, test_event_id, 'reconcile-next-match', 'manual', 'scheduled',
    'Charlie', 'Delta', '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  transition_result := public.community_transition_match(
    test_event_id, test_court_id, test_match_id, next_match_id,
    gen_random_uuid()::text, 'SYSTEM', 'Terminal assignment test', 'PAUSED_DISPUTE'
  );
  if transition_result->>'newMatchId' <> next_match_id::text then
    raise exception 'terminal assignment fixture did not transition: %', transition_result;
  end if;

  begin
    perform public.community_session_snapshot(repeat('e', 64));
    raise exception 'terminal snapshot did not raise inactive-session SQLSTATE';
  exception
    when sqlstate 'P0003' then null;
  end;

  release_result := public.community_release_assignment(
    repeat('e', 64), gen_random_uuid()::text
  );
  if (release_result->>'duplicate')::boolean is not true
    or release_result->'assignment'->>'status' <> 'MATCH_ENDED'
    or release_result->'match'->>'id' <> test_match_id::text then
    raise exception 'terminal release response lost historical match context: %', release_result;
  end if;
  release_result := public.community_release_assignment(
    repeat('e', 64), gen_random_uuid()::text
  );
  if (release_result->>'duplicate')::boolean is not true
    or release_result->'match'->>'id' <> test_match_id::text then
    raise exception 'terminal release retry was not idempotent: %', release_result;
  end if;
end;
$$;

do $$
declare
  test_event_id uuid := gen_random_uuid();
  add_match_id uuid := gen_random_uuid();
  remove_match_id uuid := gen_random_uuid();
  add_court_id uuid := gen_random_uuid();
  remove_court_id uuid := gen_random_uuid();
  add_proposal_event_id uuid;
  remove_proposal_event_id uuid;
  add_dispute_id uuid := gen_random_uuid();
  remove_dispute_id uuid := gen_random_uuid();
  add_credit_assignment_id uuid := gen_random_uuid();
  add_credit_observation_id uuid;
  add_action_id uuid := gen_random_uuid();
  remove_action_id uuid := gen_random_uuid();
  add_score public.score_states%rowtype;
  remove_score public.score_states%rowtype;
  result jsonb;
  engagement_result jsonb;
  first_event_id text;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (test_event_id, 'Dispute reducer test', 'active', 'community-dispute-' || test_event_id::text, false);
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values
    (add_match_id, test_event_id, 'dispute-add', 'manual', 'active', 'Alpha', 'Bravo',
      '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true,"cap":null}'::jsonb),
    (remove_match_id, test_event_id, 'dispute-remove', 'manual', 'active', 'Charlie', 'Delta',
      '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true,"cap":null}'::jsonb);
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id, mode, status,
    frozen, scoring_open, preview_stream_path, program_stream_path
  ) values
    (add_court_id, test_event_id, 1, 'Dispute Add Court', add_match_id,
      'manual', 'live', false, true, 'dispute_add_preview', 'dispute_add_program'),
    (remove_court_id, test_event_id, 2, 'Dispute Remove Court', remove_match_id,
      'manual', 'live', false, true, 'dispute_remove_preview', 'dispute_remove_program');

  add_score := public.community_ensure_score_projection(
    test_event_id, add_court_id, add_match_id, 'PAUSED_DISPUTE'
  );
  update public.score_states set
    team_a_score = 20, team_b_score = 10, status = 'In Progress',
    current_rally_number = 30
  where id = add_score.id;
  update public.score_states score set
    state_hash = public.community_score_hash(score.match_id, public.community_score_input_json(score))
  where id = add_score.id returning * into add_score;

  remove_score := public.community_ensure_score_projection(
    test_event_id, remove_court_id, remove_match_id, 'PAUSED_DISPUTE'
  );
  update public.score_states set
    team_a_score = 0, team_b_score = 0,
    team_a_sets = 1, team_b_sets = 0, current_set = 2,
    set_scores = '[{"setNumber":1,"teamAScore":21,"teamBScore":19,"isComplete":true}]'::jsonb,
    status = 'In Progress', current_rally_number = 45
  where id = remove_score.id;
  update public.score_states score set
    state_hash = public.community_score_hash(score.match_id, public.community_score_input_json(score))
  where id = remove_score.id returning * into remove_score;

  insert into public.canonical_score_events (
    event_id, court_id, match_id, revision, authority_epoch, authority_mode,
    command_id, command_type, actor_type, actor_label,
    previous_state, next_state, state_hash, metadata
  ) values (
    test_event_id, add_court_id, add_match_id, add_score.revision,
    add_score.authority_epoch, 'PAUSED_DISPUTE', gen_random_uuid()::text,
    'AUTHORITY_CHANGE', 'SYSTEM', 'Unapplied add proposal',
    public.community_score_input_json(add_score), public.community_score_input_json(add_score),
    add_score.state_hash, '{"eligibleVotes":5}'::jsonb
  ) returning id into add_proposal_event_id;
  insert into public.score_disputes (
    id, event_id, court_id, match_id, rally_number, base_revision,
    canonical_event_id, expected_action_type, expected_team_side, differing_count,
    eligible_vote_count, proposal_vote_count, proposal_eligible, vote_breakdown
  ) values (
    add_dispute_id, test_event_id, add_court_id, add_match_id, 31, add_score.revision,
    add_proposal_event_id, 'ADD_POINT', 'A', 2, 5, 3, true,
    '[{"actionType":"ADD_POINT","teamSide":"A","count":3},{"actionType":"ADD_POINT","teamSide":"B","count":2}]'::jsonb
  );

  -- Model a witness whose vote opened this unapplied review. The current
  -- receipt status will change when the proposal is applied, but its review
  -- trigger credit must remain immutable for the final personal recap.
  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values (
    add_credit_assignment_id, test_event_id, add_court_id, add_match_id,
    encode(extensions.digest(convert_to('applied-review-credit:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
    'Applied review witness', 'VERIFIED_WITNESS', 'VERIFIED_COURTSIDE',
    'ACTIVE', add_score.authority_epoch, clock_timestamp() + interval '5 minutes'
  );
  insert into public.rally_observations (
    event_id, court_id, match_id, assignment_id, client_action_id,
    base_revision, rally_number, action_type, team_side
  ) values (
    test_event_id, add_court_id, add_match_id, add_credit_assignment_id,
    gen_random_uuid()::text, add_score.revision, 31, 'ADD_POINT', 'A'
  ) returning id into add_credit_observation_id;
  insert into public.contribution_receipts (
    observation_id, assignment_id, event_id, court_id, match_id,
    rally_number, status, message_code, review_triggered_at
  ) values (
    add_credit_observation_id, add_credit_assignment_id, test_event_id,
    add_court_id, add_match_id, 31, 'TRIGGERED_REVIEW',
    'CONSENSUS_PAUSED_FOR_REVIEW', clock_timestamp()
  );

  result := public.community_apply_dispute_proposal(
    add_dispute_id, add_action_id, add_score.revision, add_score.authority_epoch,
    'Dispute reducer test'
  );
  first_event_id := result->>'eventId';
  if result->>'status' <> 'RESOLVED'
    or (result->>'duplicate')::boolean is true
    or result->'score'->>'status' <> 'In Progress'
    or (result->'score'->>'currentSet')::integer <> 2
    or (result->'score'->>'teamAScore')::integer <> 0
    or (result->'score'->>'teamASets')::integer <> 1
    or result->>'outboxId' is null then
    raise exception 'dispute ADD did not use set-winning SQL reducer semantics: %', result;
  end if;
  engagement_result := public.community_engagement_json(add_match_id, add_credit_assignment_id);
  if (select status from public.contribution_receipts
      where observation_id = add_credit_observation_id) <> 'CONTRIBUTED_TO_CORRECTION'
    or (select review_triggered_at from public.contribution_receipts
        where observation_id = add_credit_observation_id) is null
    or (engagement_result->'personalSummary'->>'reviewTriggers')::integer <> 1
    or (engagement_result->'personalSummary'->>'correctionsHelped')::integer <> 1 then
    raise exception 'applied review erased immutable trigger credit: %', engagement_result;
  end if;
  begin
    update public.contribution_receipts set review_triggered_at = null
    where observation_id = add_credit_observation_id;
    raise exception 'receipt review trigger history could be cleared';
  exception
    when check_violation then null;
  end;
  result := public.community_apply_dispute_proposal(
    add_dispute_id, add_action_id, add_score.revision, add_score.authority_epoch,
    'Dispute reducer test retry'
  );
  if (result->>'duplicate')::boolean is not true
    or result->>'eventId' <> first_event_id
    or (select count(*) from public.canonical_score_events where command_id = add_action_id::text) <> 1 then
    raise exception 'dispute apply retry was not exactly-once: %', result;
  end if;

  insert into public.canonical_score_events (
    event_id, court_id, match_id, revision, authority_epoch, authority_mode,
    command_id, command_type, actor_type, actor_label,
    previous_state, next_state, state_hash, metadata
  ) values (
    test_event_id, remove_court_id, remove_match_id, remove_score.revision,
    remove_score.authority_epoch, 'PAUSED_DISPUTE', gen_random_uuid()::text,
    'AUTHORITY_CHANGE', 'SYSTEM', 'Unapplied remove proposal',
    public.community_score_input_json(remove_score), public.community_score_input_json(remove_score),
    remove_score.state_hash, '{"eligibleVotes":5}'::jsonb
  ) returning id into remove_proposal_event_id;
  insert into public.score_disputes (
    id, event_id, court_id, match_id, rally_number, base_revision,
    canonical_event_id, expected_action_type, expected_team_side, differing_count,
    eligible_vote_count, proposal_vote_count, proposal_eligible, vote_breakdown
  ) values (
    remove_dispute_id, test_event_id, remove_court_id, remove_match_id, 45, remove_score.revision,
    remove_proposal_event_id, 'REMOVE_POINT', 'A', 2, 5, 3, true,
    '[{"actionType":"REMOVE_POINT","teamSide":"A","count":3},{"actionType":"ADD_POINT","teamSide":"A","count":2}]'::jsonb
  );
  result := public.community_apply_dispute_proposal(
    remove_dispute_id, remove_action_id, remove_score.revision, remove_score.authority_epoch,
    'Dispute reducer test'
  );
  if result->>'status' <> 'RESOLVED'
    or (result->'score'->>'currentSet')::integer <> 1
    or (result->'score'->>'teamAScore')::integer <> 20
    or (result->'score'->>'teamBScore')::integer <> 19
    or (result->'score'->>'teamASets')::integer <> 0
    or jsonb_array_length(result->'score'->'setScores') <> 0 then
    raise exception 'dispute REMOVE did not reopen the previous completed set: %', result;
  end if;
end;
$$;

do $$
declare
  test_event_id uuid := gen_random_uuid();
  test_match_id uuid := gen_random_uuid();
  test_court_id uuid := gen_random_uuid();
  canonical_event_one uuid;
  canonical_event_two uuid;
  outbox_one uuid;
  outbox_two uuid;
  score_row public.score_states%rowtype;
  state jsonb;
  overlay jsonb;
  result jsonb;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (test_event_id, 'Community outbox test', 'active', 'community-outbox-' || test_event_id::text, false);
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values (
    test_match_id, test_event_id, 'outbox-match', 'manual', 'active',
    'Alpha', 'Bravo', '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    test_court_id, test_event_id, 1, 'Outbox Court', test_match_id,
    'manual', 'waiting', false, true, 'outbox_preview', 'outbox_program'
  );
  score_row := public.community_ensure_score_projection(
    test_event_id, test_court_id, test_match_id, 'PAUSED_DISPUTE'
  );
  update public.score_states set revision = 2, team_a_score = 2,
    status = 'In Progress', current_rally_number = 2,
    updated_at = clock_timestamp()
  where id = score_row.id
  returning * into score_row;
  state := public.community_score_input_json(score_row);

  insert into public.canonical_score_events (
    event_id, court_id, match_id, revision, authority_epoch, authority_mode,
    command_id, command_type, team_side, actor_type, actor_label,
    previous_state, next_state, state_hash
  ) values (
    test_event_id, test_court_id, test_match_id, 1, score_row.authority_epoch,
    score_row.authority_mode, 'outbox-test-one:' || gen_random_uuid()::text,
    'ADD_POINT', 'A', 'SYSTEM', 'Outbox transaction test', state, state, score_row.state_hash
  ) returning id into canonical_event_one;
  insert into public.canonical_score_events (
    event_id, court_id, match_id, revision, authority_epoch, authority_mode,
    command_id, command_type, team_side, actor_type, actor_label,
    previous_state, next_state, state_hash
  ) values (
    test_event_id, test_court_id, test_match_id, 2, score_row.authority_epoch,
    score_row.authority_mode, 'outbox-test-two:' || gen_random_uuid()::text,
    'ADD_POINT', 'A', 'SYSTEM', 'Outbox transaction test', state, state, score_row.state_hash
  ) returning id into canonical_event_two;
  insert into public.canonical_score_outbox (
    canonical_event_id, event_id, court_id, match_id, revision, score_payload
  ) values (
    canonical_event_one, test_event_id, test_court_id, test_match_id, 1,
    public.community_score_state_json(score_row)
  ) returning id into outbox_one;
  insert into public.canonical_score_outbox (
    canonical_event_id, event_id, court_id, match_id, revision, score_payload
  ) values (
    canonical_event_two, test_event_id, test_court_id, test_match_id, 2,
    public.community_score_state_json(score_row)
  ) returning id into outbox_two;

  overlay := jsonb_build_object(
    'eventId', test_event_id,
    'courtId', test_court_id,
    'match', jsonb_build_object('id', test_match_id),
    'marker', 'atomic-publication'
  );
  result := public.community_publish_score_outbox(
    outbox_two, 1, overlay, 'live', false
  );
  if result->>'status' <> 'RETRY'
    or (result->>'currentRevision')::bigint <> 2
    or (select status from public.canonical_score_outbox where id = outbox_two) <> 'PENDING'
    or exists (select 1 from public.overlay_states where court_id = test_court_id) then
    raise exception 'revision mismatch mutated projection state: %', result;
  end if;

  result := public.community_publish_score_outbox(
    outbox_two, 2, overlay, 'live', false
  );
  if result->>'status' <> 'PUBLISHED'
    or (result->>'duplicate')::boolean is true
    or (select status from public.canonical_score_outbox where id = outbox_two) <> 'PUBLISHED'
    or (select status from public.courts where id = test_court_id) <> 'live'
    or (select payload from public.overlay_states where court_id = test_court_id) <> overlay then
    raise exception 'atomic overlay publication failed: %', result;
  end if;

  update public.courts set current_match_id = null where id = test_court_id;
  result := public.community_publish_score_outbox(
    outbox_one, 2, '{}'::jsonb, 'waiting', false
  );
  if result->>'status' <> 'HISTORICAL'
    or (result->>'duplicate')::boolean is true
    or (select status from public.canonical_score_outbox where id = outbox_one) <> 'PUBLISHED'
    or (select payload from public.overlay_states where court_id = test_court_id) <> overlay then
    raise exception 'historical publication touched the current overlay: %', result;
  end if;

  result := public.community_publish_score_outbox(
    outbox_two, 2, '{}'::jsonb, 'waiting', false
  );
  if result->>'status' <> 'HISTORICAL'
    or (result->>'duplicate')::boolean is not true
    or (select payload from public.overlay_states where court_id = test_court_id) <> overlay then
    raise exception 'duplicate publication ignored current court scope: %', result;
  end if;
end;
$$;

do $$
declare
  test_event_id uuid := gen_random_uuid();
  first_match_id uuid := gen_random_uuid();
  second_match_id uuid := gen_random_uuid();
  test_court_id uuid := gen_random_uuid();
  action_id text := gen_random_uuid()::text;
  first_result jsonb;
  retry_result jsonb;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (test_event_id, 'Transition idempotency test', 'active', 'community-transition-' || test_event_id::text, false);
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values
    (first_match_id, test_event_id, 'transition-first', 'manual', 'scheduled',
      'Alpha', 'Bravo', '{"bestOf":3}'::jsonb),
    (second_match_id, test_event_id, 'transition-second', 'manual', 'scheduled',
      'Charlie', 'Delta', '{"bestOf":3}'::jsonb);
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    test_court_id, test_event_id, 1, 'Transition Court', null,
    'manual', 'waiting', false, true, 'transition_preview', 'transition_program'
  );

  first_result := public.community_transition_match(
    test_event_id, test_court_id, null, first_match_id,
    action_id, 'SYSTEM', 'Initial activation', 'PAUSED_DISPUTE'
  );
  if (first_result->>'duplicate')::boolean is true
    or first_result->>'eventId' is null
    or not exists (
      select 1 from public.canonical_score_events event
      where event.command_id = action_id
        and event.match_id = first_match_id
        and event.command_type = 'MATCH_TRANSITION'
    ) then
    raise exception 'NULL-to-match transition did not persist its base action: %', first_result;
  end if;

  retry_result := public.community_transition_match(
    test_event_id, test_court_id, first_match_id, second_match_id,
    action_id, 'SYSTEM', 'Lost-response retry', 'PAUSED_DISPUTE'
  );
  if (retry_result->>'duplicate')::boolean is not true
    or retry_result->>'eventId' <> first_result->>'eventId'
    or retry_result->>'newMatchId' <> first_match_id::text
    or (select current_match_id from public.courts where id = test_court_id) <> first_match_id then
    raise exception 'transition action id was reused for a different target: first=%, retry=%', first_result, retry_result;
  end if;
end;
$$;

do $admission_contract$
declare
  test_event_id uuid := gen_random_uuid();
  test_match_id uuid := gen_random_uuid();
  test_court_id uuid := gen_random_uuid();
  event_slug text := 'community-admission-' || test_event_id::text;
  score_row public.score_states%rowtype;
  result jsonb;
  retry_result jsonb;
  summary_result jsonb;
  quota_result jsonb;
  observer_assignment_id uuid;
  designated_assignment_id uuid;
  invite_action_id uuid := gen_random_uuid();
  invite_token_hash text;
  invite_result jsonb;
  invite_retry jsonb;
  designated_action_id uuid := gen_random_uuid();
  designated_token_hash text;
  designated_grant jsonb;
  original_expiry timestamptz := clock_timestamp() + interval '30 minutes';
  observer_session_one text;
  observer_session_two text;
  observer_session_three text;
  observer_device_hash text;
  designated_session_one text;
  designated_session_two text;
  designated_session_three text;
  designated_device_hash text;
  quota_device_hash text;
  quota_ip_hash text;
  old_counter_hash text;
  before_heartbeat timestamptz;
  due_marker timestamptz;
  attempt integer;
begin
  update public.events set is_active = false where is_active = true;
  observer_session_one := encode(extensions.digest(convert_to('observer-session-1:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  observer_session_two := encode(extensions.digest(convert_to('observer-session-2:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  observer_session_three := encode(extensions.digest(convert_to('observer-session-3:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  observer_device_hash := encode(extensions.digest(convert_to('observer-device:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  designated_session_one := encode(extensions.digest(convert_to('designated-session-1:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  designated_session_two := encode(extensions.digest(convert_to('designated-session-2:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  designated_session_three := encode(extensions.digest(convert_to('designated-session-3:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  designated_device_hash := encode(extensions.digest(convert_to('designated-device:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  quota_device_hash := encode(extensions.digest(convert_to('quota-device:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  quota_ip_hash := encode(extensions.digest(convert_to('quota-ip:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  old_counter_hash := encode(extensions.digest(convert_to('expired-counter:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex');
  invite_token_hash := encode(extensions.digest(
    convert_to('mcs:v1:' || invite_action_id::text, 'UTF8'), 'sha256'
  ), 'hex');
  designated_token_hash := encode(extensions.digest(
    convert_to('mcs:v1:' || designated_action_id::text, 'UTF8'), 'sha256'
  ), 'hex');

  insert into public.events (id, name, status, slug, is_active)
  values (test_event_id, 'Admission contract test', 'active', event_slug, true);
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values (
    test_match_id, test_event_id, 'admission-match', 'manual', 'active',
    'Alpha', 'Bravo', '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path,
    youtube_video_id
  ) values (
    test_court_id, test_event_id, 1, 'Admission Court', test_match_id,
    'manual', 'live', false, true, 'admission_preview', 'admission_program',
    'admissionPublicVideo'
  );
  score_row := public.community_ensure_score_projection(
    test_event_id, test_court_id, test_match_id, 'PAUSED_DISPUTE'
  );

  invite_result := public.community_create_join_grant(
    test_event_id, test_court_id, test_match_id, invite_action_id,
    invite_token_hash, 'VERIFIED_WITNESS', 'Invite idempotency', 3,
    original_expiry, 'Admission fixture'
  );
  invite_retry := public.community_create_join_grant(
    test_event_id, test_court_id, test_match_id, invite_action_id,
    invite_token_hash, 'VERIFIED_WITNESS', 'Invite idempotency', 3,
    original_expiry + interval '10 minutes', 'Admission fixture'
  );
  if invite_result->>'id' <> invite_retry->>'id'
    or (invite_result->>'duplicate')::boolean is true
    or (invite_retry->>'duplicate')::boolean is not true
    or (invite_retry->>'expiresAt')::timestamptz <> original_expiry then
    raise exception 'join grant retry did not preserve its original identity/expiry: first=%, retry=%', invite_result, invite_retry;
  end if;
  begin
    perform public.community_create_join_grant(
      test_event_id, test_court_id, test_match_id, invite_action_id,
      invite_token_hash, 'VERIFIED_WITNESS', 'Invite idempotency', 4,
      original_expiry, 'Admission fixture'
    );
    raise exception 'join grant action reuse accepted a different configuration';
  exception when sqlstate '23514' then null;
  end;

  insert into public.community_admission_counters (
    scope_type, scope_hash, window_started_at, attempt_count, updated_at
  ) values ('DEVICE', old_counter_hash, clock_timestamp() - interval '2 hours', 1, clock_timestamp() - interval '2 hours');
  quota_result := public.community_consume_admission_quota(
    encode(extensions.digest(convert_to('retention-device:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
    encode(extensions.digest(convert_to('retention-ip:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex')
  );
  if (quota_result->>'allowed')::boolean is not true
    or exists (select 1 from public.community_admission_counters where scope_hash = old_counter_hash) then
    raise exception 'admission TTL cleanup did not remove expired pseudonymous counter: %', quota_result;
  end if;
  for attempt in 1..30 loop
    quota_result := public.community_consume_admission_quota(quota_device_hash, quota_ip_hash);
    if (quota_result->>'allowed')::boolean is not true then
      raise exception 'device quota rejected attempt % too early: %', attempt, quota_result;
    end if;
  end loop;
  quota_result := public.community_consume_admission_quota(quota_device_hash, quota_ip_hash);
  if (quota_result->>'allowed')::boolean is not false
    or quota_result->>'reason' <> 'DEVICE_RATE_LIMIT'
    or (quota_result->>'deviceAttempts')::integer <> 31 then
    raise exception 'device quota did not persist the rejected attempt: %', quota_result;
  end if;

  result := public.community_join_assignment(
    event_slug, 1, 'Observer one', observer_session_one, observer_device_hash,
    'OBSERVER', 'REMOTE', null, 120
  );
  observer_assignment_id := (result->'assignment'->>'id')::uuid;
  if result->'match' ? 'youtubeVideoId'
    or result->'match' ? 'previewStreamPath'
    or result->'match' ? 'programStreamPath' then
    raise exception 'community match DTO leaked a provider or media source: %', result->'match';
  end if;
  retry_result := public.community_join_assignment(
    event_slug, 1, 'Observer renamed', observer_session_two, observer_device_hash,
    'OBSERVER', 'REMOTE', null, 120
  );
  if (retry_result->>'duplicate')::boolean is not true
    or retry_result->'assignment'->>'id' <> observer_assignment_id::text
    or (select count(*) from public.community_assignments
        where match_id = test_match_id and device_token_hash = observer_device_hash and status = 'ACTIVE') <> 1
    or (select session_token_hash from public.community_assignments where id = observer_assignment_id) <> observer_session_two then
    raise exception 'same-device join did not rotate one active assignment: %', retry_result;
  end if;

  select updated_at into before_heartbeat
  from public.community_assignments where id = observer_assignment_id;
  perform public.community_heartbeat_assignment(observer_session_two, 120);
  perform public.community_heartbeat_assignment(observer_session_two, 120);
  if (select updated_at from public.community_assignments where id = observer_assignment_id) <> before_heartbeat then
    raise exception 'rapid healthy heartbeats churned assignment updated_at';
  end if;
  update public.community_assignments set
    lease_expires_at = clock_timestamp() + interval '30 seconds',
    updated_at = clock_timestamp() - interval '1 minute'
  where id = observer_assignment_id
  returning updated_at into due_marker;
  perform public.community_heartbeat_assignment(observer_session_two, 120);
  if (select updated_at from public.community_assignments where id = observer_assignment_id) <= due_marker
    or (select lease_expires_at from public.community_assignments where id = observer_assignment_id) < clock_timestamp() + interval '100 seconds' then
    raise exception 'due heartbeat did not renew the assignment';
  end if;

  update public.community_assignments set
    status = 'EXPIRED', lease_expires_at = clock_timestamp() - interval '1 second',
    ended_at = clock_timestamp()
  where id = observer_assignment_id;
  result := public.community_join_assignment(
    event_slug, 1, 'Observer reactivated', observer_session_three, observer_device_hash,
    'OBSERVER', 'REMOTE', null, 120
  );
  if (result->>'duplicate')::boolean is true
    or result->'assignment'->>'id' <> observer_assignment_id::text
    or result->'assignment'->>'status' <> 'ACTIVE'
    or result->'assignment'->>'role' <> 'OBSERVER' then
    raise exception 'expired ordinary assignment did not reactivate safely: %', result;
  end if;
  update public.community_assignments set
    status = 'REVOKED', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = observer_assignment_id;
  begin
    perform public.community_join_assignment(
      event_slug, 1, 'Blocked observer',
      encode(extensions.digest(convert_to('blocked-session:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      observer_device_hash, 'OBSERVER', 'REMOTE', null, 120
    );
    raise exception 'revoked device rejoined without organizer authorization';
  exception when sqlstate '28000' then null;
  end;
  result := public.community_join_assignment(
    event_slug, 1, 'Organizer reauthorized witness',
    encode(extensions.digest(convert_to('reauthorized-session:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
    observer_device_hash, 'OBSERVER', 'COURTSIDE', invite_token_hash, 120
  );
  if result->'assignment'->>'id' = observer_assignment_id::text
    or result->'assignment'->>'role' <> 'VERIFIED_WITNESS'
    or result->'assignment'->>'status' <> 'ACTIVE' then
    raise exception 'fresh organizer grant did not recover a revoked match-scoped device: %', result;
  end if;
  update public.community_assignments set
    status = 'REVOKED', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = (result->'assignment'->>'id')::uuid;

  designated_grant := public.community_create_join_grant(
    test_event_id, test_court_id, test_match_id, designated_action_id,
    designated_token_hash, 'DESIGNATED_SCORER', 'Designated recovery', 1,
    original_expiry, 'Admission fixture'
  );
  result := public.community_join_assignment(
    event_slug, 1, 'Designated scorer', designated_session_one, designated_device_hash,
    'DESIGNATED_SCORER', 'COURTSIDE', designated_token_hash, 120
  );
  if result->'assignment'->>'trustTier' <> 'REMOTE' then
    raise exception 'bearer designated grant incorrectly created physical-courtside trust: %', result;
  end if;
  designated_assignment_id := (result->'assignment'->>'id')::uuid;
  update public.community_assignments set lease_expires_at = clock_timestamp() - interval '1 second'
  where id = designated_assignment_id;
  result := public.community_join_assignment(
    event_slug, 1, 'Former designated', designated_session_two, designated_device_hash,
    'OBSERVER', 'REMOTE', null, 120
  );
  select * into score_row from public.score_states where match_id = test_match_id;
  if result->'assignment'->>'id' <> designated_assignment_id::text
    or result->'assignment'->>'role' <> 'OBSERVER'
    or score_row.authority_mode <> 'PAUSED_DISPUTE' then
    raise exception 'expired designated trust leaked through device identity: result=%, score=%', result, score_row;
  end if;
  result := public.community_join_assignment(
    event_slug, 1, 'Designated restored', designated_session_three, designated_device_hash,
    'DESIGNATED_SCORER', 'COURTSIDE', designated_token_hash, 120
  );
  select * into score_row from public.score_states where match_id = test_match_id;
  if result->'assignment'->>'id' <> designated_assignment_id::text
    or result->'assignment'->>'role' <> 'DESIGNATED_SCORER'
    or result->'assignment'->>'trustTier' <> 'REMOTE'
    or score_row.authority_mode <> 'DESIGNATED_PRIMARY'
    or (select use_count from public.community_join_grants where id = (designated_grant->>'id')::uuid) <> 1 then
    raise exception 'valid current grant did not safely restore designated authority: result=%, score=%', result, score_row;
  end if;

  insert into public.community_assignments (
    event_id, court_id, match_id, session_token_hash, device_token_hash,
    display_name, role, trust_tier, status, authority_epoch,
    lease_expires_at, last_seen_at
  )
  select test_event_id, test_court_id, test_match_id,
    encode(extensions.digest(convert_to('bulk-session:' || test_event_id::text || ':' || item::text, 'UTF8'), 'sha256'), 'hex'),
    encode(extensions.digest(convert_to('bulk-device:' || test_event_id::text || ':' || item::text, 'UTF8'), 'sha256'), 'hex'),
    'Observer ' || item::text, 'OBSERVER', 'REMOTE', 'ACTIVE', score_row.authority_epoch,
    clock_timestamp() + interval '5 minutes', clock_timestamp()
  from generate_series(1, 500) item;

  begin
    perform public.community_join_assignment(
      event_slug, 1, 'Capacity overflow',
      encode(extensions.digest(convert_to('overflow-session:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      encode(extensions.digest(convert_to('overflow-device:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      'OBSERVER', 'REMOTE', null, 120
    );
    raise exception 'observer capacity accepted a 501st ordinary/verified slot';
  exception when sqlstate 'P0004' then null;
  end;

  summary_result := public.community_admin_assignment_summary(test_event_id, 25);
  if jsonb_array_length(summary_result->'assignments') <> 26
    or (summary_result->'courtCounts'->0->>'activeAssignmentCount')::integer <> 501
    or (summary_result->'courtCounts'->0->>'activeObserverCount')::integer <> 500
    or (summary_result->'courtCounts'->0->>'activeDesignatedCount')::integer <> 1
    or (summary_result->'courtCounts'->0->>'returnedObserverCount')::integer <> 25 then
    raise exception 'bounded admin assignment DTO lost elevated rows or truthful totals: %', summary_result;
  end if;
end;
$admission_contract$;

do $evidence_contract$
declare
  test_event_id uuid := gen_random_uuid();
  remote_match_id uuid := gen_random_uuid();
  verified_match_id uuid := gen_random_uuid();
  boundary_match_id uuid := gen_random_uuid();
  remote_court_id uuid := gen_random_uuid();
  verified_court_id uuid := gen_random_uuid();
  boundary_court_id uuid := gen_random_uuid();
  remote_score public.score_states%rowtype;
  verified_score public.score_states%rowtype;
  boundary_score public.score_states%rowtype;
  remote_assignment_one uuid := gen_random_uuid();
  remote_assignment_two uuid := gen_random_uuid();
  verified_assignment_one uuid := gen_random_uuid();
  verified_assignment_two uuid := gen_random_uuid();
  verified_assignment_three uuid := gen_random_uuid();
  boundary_assignment_id uuid := gen_random_uuid();
  boundary_session_hash text;
  linked_boundary_event_id uuid;
  post_dispute_id uuid;
  boundary_dispute_id uuid := gen_random_uuid();
  result jsonb;
  retry_result jsonb;
  commit_result jsonb;
  engagement_result jsonb;
  list_result jsonb;
  next_state jsonb;
  item integer;
begin
  boundary_session_hash := encode(extensions.digest(
    convert_to('boundary-session:' || test_event_id::text, 'UTF8'), 'sha256'
  ), 'hex');
  insert into public.events (id, name, status, slug, is_active)
  values (test_event_id, 'Evidence threshold test', 'active', 'community-evidence-' || test_event_id::text, false);
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values
    (remote_match_id, test_event_id, 'remote-dissent', 'manual', 'active', 'Alpha', 'Bravo',
      '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb),
    (verified_match_id, test_event_id, 'verified-dissent', 'manual', 'active', 'Charlie', 'Delta',
      '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb),
    (boundary_match_id, test_event_id, 'dismissal-boundary', 'manual', 'active', 'Echo', 'Foxtrot',
      '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb);
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values
    (remote_court_id, test_event_id, 1, 'Remote Dissent Court', remote_match_id,
      'manual', 'live', false, true, 'remote_dissent_preview', 'remote_dissent_program'),
    (verified_court_id, test_event_id, 2, 'Verified Dissent Court', verified_match_id,
      'manual', 'live', false, true, 'verified_dissent_preview', 'verified_dissent_program'),
    (boundary_court_id, test_event_id, 3, 'Boundary Court', boundary_match_id,
      'manual', 'live', false, true, 'boundary_preview', 'boundary_program');
  remote_score := public.community_ensure_score_projection(
    test_event_id, remote_court_id, remote_match_id, 'ADMIN_LOCKED'
  );
  verified_score := public.community_ensure_score_projection(
    test_event_id, verified_court_id, verified_match_id, 'ADMIN_LOCKED'
  );
  boundary_score := public.community_ensure_score_projection(
    test_event_id, boundary_court_id, boundary_match_id, 'PAUSED_DISPUTE'
  );

  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values
    (remote_assignment_one, test_event_id, remote_court_id, remote_match_id,
      encode(extensions.digest(convert_to('remote-1:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      'Remote one', 'OBSERVER', 'REMOTE', 'ACTIVE', remote_score.authority_epoch, clock_timestamp() + interval '5 minutes'),
    (remote_assignment_two, test_event_id, remote_court_id, remote_match_id,
      encode(extensions.digest(convert_to('remote-2:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      'Remote two', 'OBSERVER', 'REMOTE', 'ACTIVE', remote_score.authority_epoch, clock_timestamp() + interval '5 minutes'),
    (verified_assignment_one, test_event_id, verified_court_id, verified_match_id,
      encode(extensions.digest(convert_to('verified-1:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      'Verified one', 'VERIFIED_WITNESS', 'VERIFIED_COURTSIDE', 'ACTIVE', verified_score.authority_epoch, clock_timestamp() + interval '5 minutes'),
    (verified_assignment_two, test_event_id, verified_court_id, verified_match_id,
      encode(extensions.digest(convert_to('verified-2:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      'Verified two', 'VERIFIED_WITNESS', 'VERIFIED_COURTSIDE', 'ACTIVE', verified_score.authority_epoch, clock_timestamp() + interval '5 minutes'),
    (verified_assignment_three, test_event_id, verified_court_id, verified_match_id,
      encode(extensions.digest(convert_to('verified-3:' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      'Verified three', 'VERIFIED_WITNESS', 'VERIFIED_COURTSIDE', 'ACTIVE', verified_score.authority_epoch, clock_timestamp() + interval '5 minutes');

  perform public.community_submit_observation(
    (select session_token_hash from public.community_assignments where id = remote_assignment_one),
    gen_random_uuid()::text, 0, 'ADD_POINT', 'B', null, 1
  );
  perform public.community_submit_observation(
    (select session_token_hash from public.community_assignments where id = remote_assignment_two),
    gen_random_uuid()::text, 0, 'ADD_POINT', 'B', null, 1
  );
  next_state := public.community_reduce_score_action(
    public.community_score_input_json(remote_score),
    '{"type":"ADD_POINT","team":"A"}'::jsonb,
    (select format from public.matches where id = remote_match_id)
  );
  commit_result := public.community_commit_locked_score(
    remote_match_id, null, gen_random_uuid()::text, 'ADD_POINT', 'A',
    'ADMIN', 'Remote dissent fixture', 0, remote_score.authority_epoch,
    'ADMIN_LOCKED', next_state,
    '{"source":"override","sourceAvailable":false,"sourcePriority":"override","sourcePendingScores":[],"stale":false,"message":null}'::jsonb,
    '{}'::jsonb
  );
  if exists (
      select 1 from public.score_disputes
      where match_id = remote_match_id and status in ('OPEN', 'ACKNOWLEDGED')
    )
    or (select count(*) from public.contribution_receipts
        where match_id = remote_match_id and status = 'DIFFERED') <> 2
    or (select status from public.rally_resolutions where match_id = remote_match_id) <> 'CONFIRMED' then
    raise exception 'two anonymous dissenters opened or displayed a global review';
  end if;

  next_state := public.community_reduce_score_action(
    public.community_score_input_json(verified_score),
    '{"type":"ADD_POINT","team":"A"}'::jsonb,
    (select format from public.matches where id = verified_match_id)
  );
  commit_result := public.community_commit_locked_score(
    verified_match_id, null, gen_random_uuid()::text, 'ADD_POINT', 'A',
    'ADMIN', 'Verified dissent fixture', 0, verified_score.authority_epoch,
    'ADMIN_LOCKED', next_state,
    '{"source":"override","sourceAvailable":false,"sourcePriority":"override","sourcePendingScores":[],"stale":false,"message":null}'::jsonb,
    '{}'::jsonb
  );
  select * into verified_score from public.score_states where match_id = verified_match_id;
  perform public.community_change_authority(
    verified_match_id, 'PAUSED_DISPUTE', verified_score.authority_epoch,
    gen_random_uuid()::text, 'SYSTEM', 'Late evidence authority shadow fixture'
  );
  select * into verified_score from public.score_states where match_id = verified_match_id;

  -- The point is already canonical and a higher-epoch AUTHORITY_CHANGE now
  -- shares revision 1. Late lookup must still compare against the ADD_POINT.
  perform public.community_submit_observation(
    (select session_token_hash from public.community_assignments where id = verified_assignment_three),
    gen_random_uuid()::text, 0, 'ADD_POINT', 'A', null, 1
  );
  if (select status from public.contribution_receipts where assignment_id = verified_assignment_three) <> 'CONFIRMED' then
    raise exception 'same-revision authority event shadowed a late matching point receipt';
  end if;
  perform public.community_submit_observation(
    (select session_token_hash from public.community_assignments where id = verified_assignment_one),
    gen_random_uuid()::text, 0, 'ADD_POINT', 'B', null, 1
  );
  if exists (
    select 1 from public.score_disputes
    where match_id = verified_match_id and status in ('OPEN', 'ACKNOWLEDGED')
  ) then
    raise exception 'one late verified dissenter opened a review before threshold';
  end if;
  perform public.community_submit_observation(
    (select session_token_hash from public.community_assignments where id = verified_assignment_two),
    gen_random_uuid()::text, 0, 'ADD_POINT', 'B', null, 1
  );
  select id into post_dispute_id
  from public.score_disputes
  where match_id = verified_match_id and status in ('OPEN', 'ACKNOWLEDGED');
  if post_dispute_id is null
    or (select count(*) from public.score_disputes
        where match_id = verified_match_id and status in ('OPEN', 'ACKNOWLEDGED')) <> 1
    or (select count(*) from public.contribution_receipts
        where match_id = verified_match_id and status = 'TRIGGERED_REVIEW') <> 2
    or (select count(*) from public.contribution_receipts
        where match_id = verified_match_id and review_triggered_at is not null) <> 2
    or (public.community_engagement_json(verified_match_id, verified_assignment_one)
        ->'personalSummary'->>'reviewTriggers')::integer <> 1
    or (select status from public.rally_resolutions where match_id = verified_match_id) <> 'DISPUTED' then
    raise exception 'two verified courtside dissenters did not open exactly one truthful review';
  end if;
  select * into verified_score from public.score_states where match_id = verified_match_id;
  result := public.community_resolve_dispute(
    post_dispute_id, 'DISMISSED', 'Keep the applied canonical point', null,
    verified_score.revision, verified_score.authority_epoch, 'Evidence fixture'
  );
  if (select status from public.rally_resolutions where match_id = verified_match_id) <> 'CONFIRMED'
    or (select status from public.contribution_receipts where assignment_id = verified_assignment_three) <> 'CONFIRMED'
    or (select count(*) from public.contribution_receipts
        where match_id = verified_match_id and status = 'DIFFERED') <> 2
    or (select count(*) from public.contribution_receipts
        where match_id = verified_match_id and review_triggered_at is not null) <> 2
    or (public.community_engagement_json(verified_match_id, verified_assignment_one)
        ->'personalSummary'->>'reviewTriggers')::integer <> 1
    or (select review_triggered_at from public.contribution_receipts
        where assignment_id = verified_assignment_three) is not null
    or result->>'eventId' is not null then
    raise exception 'post-canonical keep-current did not preserve canonical truth: %', result;
  end if;

  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values (
    boundary_assignment_id, test_event_id, boundary_court_id, boundary_match_id,
    boundary_session_hash, 'Boundary witness one', 'VERIFIED_WITNESS',
    'VERIFIED_COURTSIDE', 'ACTIVE', boundary_score.authority_epoch,
    clock_timestamp() + interval '5 minutes'
  );
  for item in 2..5 loop
    insert into public.community_assignments (
      event_id, court_id, match_id, session_token_hash, display_name,
      role, trust_tier, status, authority_epoch, lease_expires_at
    ) values (
      test_event_id, boundary_court_id, boundary_match_id,
      encode(extensions.digest(convert_to('boundary-session-' || item::text || ':' || test_event_id::text, 'UTF8'), 'sha256'), 'hex'),
      'Boundary witness ' || item::text, 'VERIFIED_WITNESS',
      'VERIFIED_COURTSIDE', 'ACTIVE', boundary_score.authority_epoch,
      clock_timestamp() + interval '5 minutes'
    );
  end loop;
  insert into public.canonical_score_events (
    event_id, court_id, match_id, revision, authority_epoch, authority_mode,
    command_id, command_type, actor_type, actor_label,
    previous_state, next_state, state_hash, metadata
  ) values (
    test_event_id, boundary_court_id, boundary_match_id, boundary_score.revision,
    boundary_score.authority_epoch, 'PAUSED_DISPUTE', gen_random_uuid()::text,
    'AUTHORITY_CHANGE', 'SYSTEM', 'No automatic consensus',
    public.community_score_input_json(boundary_score), public.community_score_input_json(boundary_score),
    boundary_score.state_hash, '{"eligibleVotes":5}'::jsonb
  ) returning id into linked_boundary_event_id;
  insert into public.score_disputes (
    id, event_id, court_id, match_id, rally_number, base_revision,
    canonical_event_id, expected_action_type, expected_team_side, differing_count,
    eligible_vote_count, proposal_vote_count, proposal_eligible, vote_breakdown
  ) values (
    boundary_dispute_id, test_event_id, boundary_court_id, boundary_match_id,
    1, boundary_score.revision, linked_boundary_event_id, 'ADD_POINT', 'A', 3,
    5, 2, false,
    '[{"actionType":"ADD_POINT","teamSide":"A","count":2},{"actionType":"ADD_POINT","teamSide":"B","count":2},{"actionType":"REMOVE_POINT","teamSide":"A","count":1}]'::jsonb
  );
  insert into public.rally_observations (
    event_id, court_id, match_id, assignment_id, client_action_id,
    base_revision, rally_number, action_type, team_side
  )
  select test_event_id, boundary_court_id, boundary_match_id, assignment.id,
    gen_random_uuid()::text, 0, 1,
    case when row_number() over (order by assignment.id) = 5 then 'REMOVE_POINT' else 'ADD_POINT' end,
    case when row_number() over (order by assignment.id) in (1, 2) then 'A' else 'B' end
  from public.community_assignments assignment
  where assignment.match_id = boundary_match_id;
  insert into public.contribution_receipts (
    observation_id, assignment_id, event_id, court_id, match_id,
    rally_number, status, message_code
  )
  select observation.id, observation.assignment_id, test_event_id,
    boundary_court_id, boundary_match_id, 1, 'RECORDED', 'EVIDENCE_RECORDED'
  from public.rally_observations observation
  where observation.match_id = boundary_match_id;

  result := public.community_resolve_dispute(
    boundary_dispute_id, 'DISMISSED', 'No proposal met the automatic threshold', null,
    boundary_score.revision, boundary_score.authority_epoch, 'Evidence fixture'
  );
  select * into boundary_score from public.score_states where match_id = boundary_match_id;
  engagement_result := public.community_engagement_json(boundary_match_id, boundary_assignment_id);
  if boundary_score.revision <> 1
    or boundary_score.authority_mode <> 'VERIFIED_CONSENSUS'
    or result->>'eventId' is null or result->>'outboxId' is null
    or (select command_type from public.canonical_score_events where id = (result->>'eventId')::uuid) <> 'REVIEW_DISMISSED'
    or (select status from public.rally_resolutions where match_id = boundary_match_id and rally_number = 1) <> 'VOIDED'
    or (engagement_result->>'hasContributedToCurrentRevision')::boolean is not false then
    raise exception 'no-consensus keep-current did not create a fresh canonical decision boundary: result=%, score=%, engagement=%',
      result, boundary_score, engagement_result;
  end if;
  retry_result := public.community_resolve_dispute(
    boundary_dispute_id, 'DISMISSED', 'Lost response retry', null,
    0, 1, 'Evidence fixture retry'
  );
  if (retry_result->>'duplicate')::boolean is not true
    or retry_result->>'eventId' <> result->>'eventId'
    or retry_result->>'outboxId' <> result->>'outboxId'
    or (select count(*) from public.canonical_score_events
        where command_id = 'review-dismissed:' || boundary_dispute_id::text) <> 1 then
    raise exception 'review dismissal boundary retry was not idempotent: %', retry_result;
  end if;
  perform public.community_submit_observation(
    boundary_session_hash, gen_random_uuid()::text, boundary_score.revision,
    'ADD_POINT', 'A', null, 2
  );
  engagement_result := public.community_engagement_json(boundary_match_id, boundary_assignment_id);
  if (engagement_result->>'hasContributedToCurrentRevision')::boolean is not true then
    raise exception 'witness could not contribute again after dismissal boundary: %', engagement_result;
  end if;
  list_result := public.community_list_open_disputes(test_event_id, null);
  if jsonb_typeof(list_result) <> 'object'
    or not (list_result ? 'disputes')
    or (list_result->>'totalOpenCount')::integer <> 0
    or (list_result->>'truncated')::boolean is not false
    or (list_result->>'limit')::integer <> 200 then
    raise exception 'bounded dispute queue wrapper is not truthful: %', list_result;
  end if;
end;
$evidence_contract$;

rollback;
