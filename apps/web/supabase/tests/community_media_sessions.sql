-- Executable lifecycle and evidence checks for Community Witness WHEP media.
-- Run after applying migrations through 028.

begin;

do $community_media_sessions$
declare
  test_event_id uuid := gen_random_uuid();
  test_match_id uuid := gen_random_uuid();
  test_court_id uuid := gen_random_uuid();
  other_event_id uuid := gen_random_uuid();
  other_match_id uuid := gen_random_uuid();
  other_court_id uuid := gen_random_uuid();
  first_assignment_id uuid := gen_random_uuid();
  second_assignment_id uuid := gen_random_uuid();
  first_reservation jsonb;
  replacement_reservation jsonb;
  second_reservation jsonb;
  claimed jsonb;
  claimed_list jsonb;
  close_claim_token uuid := gen_random_uuid();
  capacity_claim_token uuid := gen_random_uuid();
  crashed_claim_token uuid := gen_random_uuid();
  replacement_claim_token uuid := gen_random_uuid();
  score_row public.score_states%rowtype;
  capacity_rejected boolean := false;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (
    test_event_id, 'Community media test', 'active',
    'community-media-' || test_event_id::text, false
  );
  insert into public.matches (
    id, event_id, external_match_id, source_type, status,
    team_a, team_b, format
  ) values (
    test_match_id, test_event_id, 'community-media-match', 'manual', 'active',
    'Alpha', 'Bravo',
    '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    test_court_id, test_event_id, 1, 'Community Media Court', test_match_id,
    'manual', 'live', false, true, 'court1_preview', 'court1_program'
  );
  score_row := public.community_ensure_score_projection(
    test_event_id, test_court_id, test_match_id, 'PAUSED_DISPUTE'
  );
  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values
    (
      first_assignment_id, test_event_id, test_court_id, test_match_id,
      repeat('f', 64), 'Media observer one', 'OBSERVER', 'REMOTE', 'ACTIVE',
      score_row.authority_epoch, clock_timestamp() + interval '5 minutes'
    ),
    (
      second_assignment_id, test_event_id, test_court_id, test_match_id,
      repeat('e', 64), 'Media observer two', 'OBSERVER', 'REMOTE', 'ACTIVE',
      score_row.authority_epoch, clock_timestamp() + interval '5 minutes'
    );

  insert into public.events (id, name, status, slug, is_active)
  values (
    other_event_id, 'Other community media event', 'active',
    'community-media-other-' || other_event_id::text, false
  );
  insert into public.matches (
    id, event_id, external_match_id, source_type, status,
    team_a, team_b, format
  ) values (
    other_match_id, other_event_id, 'community-media-other-match', 'manual', 'active',
    'Charlie', 'Delta',
    '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    other_court_id, other_event_id, 2, 'Other Community Media Court', other_match_id,
    'manual', 'live', false, true, 'court2_preview', 'court2_program'
  );
  perform public.community_ensure_score_projection(
    other_event_id, other_court_id, other_match_id, 'PAUSED_DISPUTE'
  );
  insert into public.community_assignments (
    event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values (
    other_event_id, other_court_id, other_match_id, repeat('d', 64),
    'Other event observer', 'OBSERVER', 'REMOTE', 'ACTIVE', 1,
    clock_timestamp() + interval '5 minutes'
  );

  first_reservation := public.community_reserve_media_session(
    repeat('f', 64), 1, 1, 120
  );
  begin
    perform public.community_reserve_media_session(repeat('f', 64), 1, 1, 120);
    raise exception 'an in-flight reservation was replaced before its upstream resource was known';
  exception when sqlstate '55000' then null;
  end;
  if (select status from public.community_media_sessions
      where id = (first_reservation->>'id')::uuid) <> 'RESERVING' then
    raise exception 'in-flight reconnect changed the original reservation state';
  end if;
  perform public.community_activate_media_session(
    repeat('f', 64), (first_reservation->>'id')::uuid,
    'https://edge.example.com/webrtc/court1_preview/whep/session-one',
    'SERVERID=edge-a'
  );

  -- A reconnect may reserve a replacement and claim the old resource for
  -- synchronous cleanup without violating the one-open-session index.
  replacement_reservation := public.community_reserve_media_session(
    repeat('f', 64), 1, 1, 120
  );
  if replacement_reservation #>> '{replaced,id}' <> first_reservation->>'id' then
    raise exception 'reconnect did not identify the exact replaced resource: %', replacement_reservation;
  end if;
  claimed := public.community_claim_media_session_close(
    repeat('f', 64), (first_reservation->>'id')::uuid, 'replacement-test', close_claim_token, 30
  );
  if claimed->>'id' <> first_reservation->>'id'
    or claimed->>'upstreamResourceUrl' is null then
    raise exception 'reconnect cleanup could not claim the replaced resource: %', claimed;
  end if;
  perform public.community_finish_media_cleanup(
    (first_reservation->>'id')::uuid, 'replacement-test', close_claim_token, true, null
  );
  perform public.community_activate_media_session(
    repeat('f', 64), (replacement_reservation->>'id')::uuid,
    'https://edge.example.com/webrtc/court1_preview/whep/session-two', null
  );

  -- CLOSE_REQUESTED still owns an upstream resource, so even an assignment in
  -- another event cannot consume the shared edge's final slot until DELETE.
  perform public.community_request_media_session_close(repeat('f', 64));
  begin
    perform public.community_reserve_media_session(repeat('d', 64), 1, 1, 120);
  exception when sqlstate 'P0004' then
    capacity_rejected := true;
  end;
  if not capacity_rejected then
    raise exception 'closing upstream resource was excluded from capacity';
  end if;

  claimed_list := public.community_claim_media_cleanup('capacity-release', capacity_claim_token, 10, 30);
  if jsonb_array_length(claimed_list) <> 1
    or claimed_list->0->>'id' <> replacement_reservation->>'id' then
    raise exception 'worker did not claim the closing capacity resource: %', claimed_list;
  end if;
  perform public.community_finish_media_cleanup(
    (replacement_reservation->>'id')::uuid, 'capacity-release', capacity_claim_token, true, null
  );
  if exists (
    select 1 from public.community_media_sessions
    where id = (replacement_reservation->>'id')::uuid
      and (upstream_resource_url is not null or upstream_affinity_cookie is not null)
  ) then
    raise exception 'successful cleanup retained sensitive upstream resource data';
  end if;

  -- If upstream POST succeeded but immediate cleanup failed, the opaque URL
  -- is retained durably instead of being discarded in FAILED state.
  second_reservation := public.community_reserve_media_session(
    repeat('e', 64), 1, 1, 120
  );
  perform public.community_fail_media_session(
    (second_reservation->>'id')::uuid,
    'activation failed after upstream admission',
    'https://edge.example.com/webrtc/court1_preview/whep/session-orphan',
    'SERVERID=edge-b'
  );
  if not exists (
    select 1 from public.community_media_sessions media
    where media.id = (second_reservation->>'id')::uuid
      and media.status = 'CLOSE_REQUESTED'
      and media.upstream_resource_url like '%/session-orphan'
      and media.closed_at is null
  ) then
    raise exception 'failed setup discarded its admitted upstream resource';
  end if;

  claimed_list := public.community_claim_media_cleanup('crashed-cleaner', crashed_claim_token, 10, 30);
  if claimed_list->0->>'id' <> second_reservation->>'id' then
    raise exception 'durable failed-setup resource was not claimable: %', claimed_list;
  end if;
  update public.community_media_sessions
  set cleanup_claim_expires_at = clock_timestamp() - interval '1 second'
  where id = (second_reservation->>'id')::uuid;
  claimed_list := public.community_claim_media_cleanup('replacement-cleaner', replacement_claim_token, 10, 30);
  if claimed_list->0->>'id' <> second_reservation->>'id' then
    raise exception 'expired CLEANING claim was not immediately recoverable: %', claimed_list;
  end if;
  -- A stale worker cannot finish a resource after a newer claim token fences it.
  perform public.community_finish_media_cleanup(
    (second_reservation->>'id')::uuid, 'crashed-cleaner', crashed_claim_token, true, null
  );
  if (select status from public.community_media_sessions where id = (second_reservation->>'id')::uuid) <> 'CLEANING' then
    raise exception 'stale cleanup claim completed a newer lease';
  end if;
  perform public.community_finish_media_cleanup(
    (second_reservation->>'id')::uuid, 'replacement-cleaner', replacement_claim_token, true, null
  );

  if has_table_privilege('anon', 'public.community_media_sessions', 'SELECT')
    or has_table_privilege('authenticated', 'public.community_playback_evidence', 'SELECT')
    or has_function_privilege(
      'anon',
      'public.community_reserve_media_session(text,integer,integer,integer)',
      'EXECUTE'
    ) or has_function_privilege(
      'service_role',
      'public.community_record_playback_evidence(text,text,bigint,text,text,jsonb)',
      'EXECUTE'
    ) then
    raise exception 'browser roles retained community media ledger privileges';
  end if;
end;
$community_media_sessions$;

do $community_media_capacity_priority$
declare
  event_id uuid := gen_random_uuid();
  match_id uuid := gen_random_uuid();
  court_id uuid := gen_random_uuid();
  observer_id uuid := gen_random_uuid();
  scorer_id uuid := gen_random_uuid();
  stale_media_id uuid := gen_random_uuid();
  scorer_reservation jsonb;
  cleanup_claim_token uuid := gen_random_uuid();
  claimed jsonb;
  score_row public.score_states%rowtype;
  observer_rejected boolean := false;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (event_id, 'Media priority test', 'active', 'media-priority-' || event_id::text, true);
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values (
    match_id, event_id, 'media-priority-match', 'manual', 'active', 'Alpha', 'Bravo',
    '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    court_id, event_id, 1, 'Priority Court', match_id,
    'manual', 'live', false, true, 'court1_preview', 'court1_program'
  );
  score_row := public.community_ensure_score_projection(event_id, court_id, match_id, 'PAUSED_DISPUTE');
  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values
    (
      observer_id, event_id, court_id, match_id, repeat('a', 64), 'Priority observer',
      'OBSERVER', 'REMOTE', 'ACTIVE', score_row.authority_epoch, clock_timestamp() + interval '5 minutes'
    ),
    (
      scorer_id, event_id, court_id, match_id, repeat('b', 64), 'Priority scorer',
      'DESIGNATED_SCORER', 'REMOTE', 'ACTIVE', score_row.authority_epoch, clock_timestamp() + interval '5 minutes'
    );

  -- Any admission self-heals expired setup reservations globally before it
  -- counts capacity, even if the background worker is unavailable.
  insert into public.community_media_sessions (
    id, assignment_id, event_id, court_id, match_id, status,
    expires_at, setup_deadline_at
  ) values (
    stale_media_id, observer_id, event_id, court_id, match_id, 'RESERVING',
    clock_timestamp() + interval '2 minutes', clock_timestamp() - interval '1 second'
  );
  begin
    perform public.community_reserve_media_session(repeat('a', 64), 1, 1, 120);
  exception when sqlstate 'P0004' then
    observer_rejected := true;
  end;
  if not observer_rejected then
    raise exception 'observer consumed the protected designated scorer slot';
  end if;
  scorer_reservation := public.community_reserve_media_session(repeat('b', 64), 1, 1, 120);
  if (select status from public.community_media_sessions where id = stale_media_id) <> 'FAILED' then
    raise exception 'stale setup reservation was not self-healed by the next successful admission';
  end if;
  perform public.community_activate_media_session(
    repeat('b', 64), (scorer_reservation->>'id')::uuid,
    'https://edge.example.com/webrtc/court1_preview/whep/priority-scorer', null
  );
  perform public.community_request_media_session_close(repeat('b', 64));

  observer_rejected := false;
  begin
    perform public.community_reserve_media_session(repeat('a', 64), 2, 2, 120);
  exception when sqlstate 'P0004' then
    observer_rejected := true;
  end;
  if not observer_rejected then
    raise exception 'closing scorer media incorrectly satisfied the protected usable scorer slot';
  end if;

  claimed := public.community_claim_media_cleanup('priority-cleaner', cleanup_claim_token, 10, 120);
  perform public.community_finish_media_cleanup(
    (scorer_reservation->>'id')::uuid,
    'priority-cleaner',
    cleanup_claim_token,
    true,
    null
  );
end;
$community_media_capacity_priority$;

do $community_commentary_claim_idempotency$
declare
  claim_event_id uuid := gen_random_uuid();
  claim_match_id uuid := gen_random_uuid();
  claim_court_id uuid := gen_random_uuid();
  observer_token_hash text := repeat('12', 32);
  claim_action_id text := gen_random_uuid()::text;
  observer_session jsonb;
  claimed_session jsonb;
  retried_session jsonb;
  reservation jsonb;
  observer_assignment_id uuid;
  media_session_id uuid;
  promoted_epoch bigint;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (
    claim_event_id, 'Commentary claim test', 'active',
    'commentary-claim-' || claim_event_id::text, false
  );
  insert into public.matches (
    id, event_id, external_match_id, source_type, status,
    team_a, team_b, format
  ) values (
    claim_match_id, claim_event_id, 'commentary-claim-match', 'manual', 'active',
    'Alpha', 'Bravo',
    '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    claim_court_id, claim_event_id, 9, 'Commentary Claim Court', claim_match_id,
    'manual', 'live', false, true, 'claim_preview', 'claim_program'
  );

  observer_session := public.community_create_trusted_assignment(
    claim_event_id, claim_court_id, claim_match_id, 'Commentator',
    observer_token_hash, 'OBSERVER', 'REMOTE', 120,
    gen_random_uuid()::text, 'Commentary viewer'
  );
  observer_assignment_id := (observer_session #>> '{assignment,id}')::uuid;
  reservation := public.community_reserve_media_session(observer_token_hash, 3, 20, 120);
  media_session_id := (reservation->>'id')::uuid;
  perform public.community_activate_media_session(
    observer_token_hash, media_session_id,
    'https://edge.example.com/webrtc/claim_preview/whep/commentary-claim', null
  );

  claimed_session := public.community_claim_trusted_designated_assignment(
    claim_event_id, claim_court_id, claim_match_id, observer_token_hash,
    'Court Caller', 120, claim_action_id, 'Commentary scorer'
  );
  promoted_epoch := (claimed_session #>> '{assignment,authorityEpoch}')::bigint;
  if (claimed_session #>> '{assignment,id}')::uuid <> observer_assignment_id
    or claimed_session #>> '{assignment,role}' <> 'DESIGNATED_SCORER'
    or claimed_session #>> '{assignment,trustTier}' <> 'REMOTE'
    or (claimed_session->>'duplicate')::boolean is not false
    or (select session_token_hash from public.community_assignments where id = observer_assignment_id)
      <> observer_token_hash
    or (select status from public.community_media_sessions where id = media_session_id) <> 'ACTIVE'
    or (select assignment_id from public.community_media_sessions where id = media_session_id)
      <> observer_assignment_id
    or (select count(*) from public.community_assignments where match_id = claim_match_id) <> 1
    or (select count(*) from public.canonical_score_events where command_id = claim_action_id) <> 1 then
    raise exception 'commentary claim did not promote in place: %', claimed_session;
  end if;

  retried_session := public.community_claim_trusted_designated_assignment(
    claim_event_id, claim_court_id, claim_match_id, observer_token_hash,
    'Court Caller', 120, claim_action_id, 'Commentary scorer'
  );
  if (retried_session #>> '{assignment,id}')::uuid <> observer_assignment_id
    or retried_session #>> '{assignment,role}' <> 'DESIGNATED_SCORER'
    or (retried_session->>'duplicate')::boolean is not true
    or (retried_session #>> '{assignment,authorityEpoch}')::bigint <> promoted_epoch
    or (select authority_epoch from public.score_states where match_id = claim_match_id) <> promoted_epoch
    or (select count(*) from public.canonical_score_events where command_id = claim_action_id) <> 1
    or (select status from public.community_media_sessions where id = media_session_id) <> 'ACTIVE' then
    raise exception 'commentary claim retry was not idempotent: %', retried_session;
  end if;
end;
$community_commentary_claim_idempotency$;

do $community_media_atomic_commands$
declare
  atomic_event_id uuid := gen_random_uuid();
  atomic_match_id uuid := gen_random_uuid();
  atomic_court_id uuid := gen_random_uuid();
  remote_token_hash text := repeat('c', 64);
  courtside_token_hash text := repeat('9', 64);
  remote_assignment jsonb;
  courtside_assignment jsonb;
  reservation jsonb;
  command_result jsonb;
  playback_evidence jsonb;
  accepted_action_id text := gen_random_uuid()::text;
  rejected_action_id text := gen_random_uuid()::text;
  accepted_set_action_id text := gen_random_uuid()::text;
  rejected_set_action_id text := gen_random_uuid()::text;
  closed_media_action_id text := gen_random_uuid()::text;
  courtside_action_id text := gen_random_uuid()::text;
  courtside_set_action_id text := gen_random_uuid()::text;
  base_revision bigint;
  accepted_revision bigint;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (atomic_event_id, 'Atomic media command test', 'active', 'atomic-media-' || atomic_event_id::text, false);
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values (
    atomic_match_id, atomic_event_id, 'atomic-media-match', 'manual', 'active', 'Alpha', 'Bravo',
    '{"bestOf":3,"setsToWin":2,"pointsPerSet":[21,21,15],"winByTwo":true}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    atomic_court_id, atomic_event_id, 3, 'Atomic Media Court', atomic_match_id,
    'manual', 'live', false, true, 'court3_preview', 'court3_program'
  );

  remote_assignment := public.community_create_trusted_assignment(
    atomic_event_id, atomic_court_id, atomic_match_id, 'Remote commentary scorer', remote_token_hash,
    'DESIGNATED_SCORER', 'REMOTE', 120, gen_random_uuid()::text, 'Commentary scorer'
  );
  if remote_assignment #>> '{assignment,trustTier}' <> 'REMOTE'
    or remote_assignment #>> '{assignment,role}' <> 'DESIGNATED_SCORER' then
    raise exception 'trusted remote designated assignment was not created: %', remote_assignment;
  end if;

  reservation := public.community_reserve_media_session(remote_token_hash, 3, 20, 120);
  perform public.community_activate_media_session(
    remote_token_hash,
    (reservation->>'id')::uuid,
    'https://edge.example.com/webrtc/court3_preview/whep/atomic-scorer',
    null
  );
  select revision into base_revision
  from public.score_states score
  where score.match_id = atomic_match_id;
  playback_evidence := jsonb_build_object(
    'version', 1,
    'sessionId', 'whep-' || (reservation->>'id'),
    'transport', 'whep',
    'connectionState', 'connected',
    'sampledAtMs', 100000,
    'baseRevision', base_revision,
    'currentTimeSeconds', 12.5,
    'readyState', 4,
    'videoWidth', 1280,
    'videoHeight', 720,
    'paused', false,
    'stalled', false,
    'reconnecting', false,
    'frame', jsonb_build_object(
      'source', 'video-frame-callback',
      'sessionId', 'whep-' || (reservation->>'id'),
      'presentedFrames', 100,
      'mediaTimeSeconds', 12.5,
      'observedAtMs', 99950
    ),
    'qualification', jsonb_build_object(
      'liveActionEligible', true,
      'blockedReason', null,
      'frameAgeMs', 50,
      'maxFrameAgeMs', 1500
    ),
    'correlation', 'uncorrelated_client_diagnostic'
  );

  begin
    perform public.community_submit_scorer_command_with_evidence(
      remote_token_hash, rejected_action_id, base_revision,
      '{"type":"ADD_POINT","team":"A"}'::jsonb, null
    );
    raise exception 'remote scorer command succeeded without playback evidence';
  exception when sqlstate 'P0005' then null;
  end;
  if (select revision from public.score_states score where score.match_id = atomic_match_id) <> base_revision
    or exists (select 1 from public.canonical_score_events where command_id = rejected_action_id) then
    raise exception 'rejected media command partially committed canonical state';
  end if;

  command_result := public.community_submit_scorer_command_with_evidence(
    remote_token_hash, accepted_action_id, base_revision,
    '{"type":"ADD_POINT","team":"A"}'::jsonb, playback_evidence
  );
  accepted_revision := base_revision + 1;
  if coalesce((command_result->>'duplicate')::boolean, true)
    or (select revision from public.score_states score where score.match_id = atomic_match_id) <> accepted_revision
    or not exists (
      select 1 from public.community_playback_evidence stored
      where stored.client_action_id = accepted_action_id
        and stored.assignment_id = (remote_assignment #>> '{assignment,id}')::uuid
    ) then
    raise exception 'qualified remote command did not atomically commit score and evidence: %', command_result;
  end if;
  if not public.community_scorer_command_recorded(remote_token_hash, accepted_action_id) then
    raise exception 'durable score receipt lookup missed an accepted command';
  end if;
  begin
    update public.community_playback_evidence
    set evidence = evidence || '{"tampered":true}'::jsonb
    where client_action_id = accepted_action_id;
    raise exception 'authoritative playback evidence permitted update';
  exception when sqlstate '55000' then null;
  end;

  playback_evidence := jsonb_set(playback_evidence, '{baseRevision}', to_jsonb(accepted_revision), false);
  begin
    perform public.community_submit_scorer_command_with_evidence(
      remote_token_hash, rejected_set_action_id, accepted_revision,
      '{"type":"SET_CURRENT_SET","set":2}'::jsonb, null
    );
    raise exception 'remote current-set command succeeded without playback evidence';
  exception when sqlstate 'P0005' then null;
  end;
  if (select revision from public.score_states score where score.match_id = atomic_match_id) <> accepted_revision
    or exists (select 1 from public.canonical_score_events where command_id = rejected_set_action_id) then
    raise exception 'rejected remote current-set command partially committed canonical state';
  end if;

  command_result := public.community_submit_scorer_command_with_evidence(
    remote_token_hash, accepted_set_action_id, accepted_revision,
    '{"type":"SET_CURRENT_SET","set":2}'::jsonb, playback_evidence
  );
  accepted_revision := accepted_revision + 1;
  if coalesce((command_result->>'duplicate')::boolean, true)
    or (select revision from public.score_states score where score.match_id = atomic_match_id) <> accepted_revision
    or (select current_set from public.score_states score where score.match_id = atomic_match_id) <> 2 then
    raise exception 'qualified remote current-set command did not commit: %', command_result;
  end if;

  perform public.community_request_media_session_close(remote_token_hash);
  command_result := public.community_submit_scorer_command_with_evidence(
    remote_token_hash, accepted_action_id, base_revision,
    '{"type":"ADD_POINT","team":"A"}'::jsonb, playback_evidence
  );
  if coalesce((command_result->>'duplicate')::boolean, false) is not true then
    raise exception 'idempotent retry did not resolve after media closed: %', command_result;
  end if;

  playback_evidence := jsonb_set(playback_evidence, '{baseRevision}', to_jsonb(accepted_revision), false);
  begin
    perform public.community_submit_scorer_command_with_evidence(
      remote_token_hash, closed_media_action_id, accepted_revision,
      '{"type":"ADD_POINT","team":"B"}'::jsonb, playback_evidence
    );
    raise exception 'new remote command succeeded against closed media';
  exception when sqlstate 'P0005' then null;
  end;
  if (select revision from public.score_states score where score.match_id = atomic_match_id) <> accepted_revision
    or exists (select 1 from public.canonical_score_events where command_id = closed_media_action_id) then
    raise exception 'closed-media rejection failed to roll back canonical command';
  end if;

  perform public.community_release_assignment(
    remote_token_hash, gen_random_uuid()::text
  );
  courtside_assignment := public.community_create_trusted_assignment(
    atomic_event_id, atomic_court_id, atomic_match_id, 'Organizer verified scorer', courtside_token_hash,
    'DESIGNATED_SCORER', 'VERIFIED_COURTSIDE', 120,
    gen_random_uuid()::text, 'Verified courtside scorer'
  );
  select revision into accepted_revision
  from public.score_states score
  where score.match_id = atomic_match_id;
  command_result := public.community_submit_scorer_command_with_evidence(
    courtside_token_hash, courtside_action_id, accepted_revision,
    '{"type":"ADD_POINT","team":"B"}'::jsonb, null
  );
  if coalesce((command_result->>'duplicate')::boolean, true)
    or (select revision from public.score_states score where score.match_id = atomic_match_id) <> accepted_revision + 1 then
    raise exception 'verified physical courtside exemption did not commit: %', command_result;
  end if;
  accepted_revision := accepted_revision + 1;
  command_result := public.community_submit_scorer_command_with_evidence(
    courtside_token_hash, courtside_set_action_id, accepted_revision,
    '{"type":"SET_CURRENT_SET","set":1}'::jsonb, null
  );
  if coalesce((command_result->>'duplicate')::boolean, true)
    or (select revision from public.score_states score where score.match_id = atomic_match_id) <> accepted_revision + 1
    or (select current_set from public.score_states score where score.match_id = atomic_match_id) <> 1 then
    raise exception 'verified physical courtside set-selection exemption did not commit: %', command_result;
  end if;
end;
$community_media_atomic_commands$;

do $community_media_retention$
declare
  retention_event_id uuid := gen_random_uuid();
  retention_match_id uuid := gen_random_uuid();
  retention_court_id uuid := gen_random_uuid();
  cascade_assignment_id uuid := gen_random_uuid();
  old_assignment_id uuid := gen_random_uuid();
  cascade_evidence_id uuid := gen_random_uuid();
  old_evidence_id uuid := gen_random_uuid();
  old_media_id uuid := gen_random_uuid();
  prune_result jsonb;
  score_row public.score_states%rowtype;
begin
  insert into public.events (id, name, status, slug, is_active)
  values (
    retention_event_id, 'Media retention test', 'inactive',
    'media-retention-' || retention_event_id::text, false
  );
  insert into public.matches (
    id, event_id, external_match_id, source_type, status, team_a, team_b, format
  ) values (
    retention_match_id, retention_event_id, 'media-retention-match', 'manual',
    'active', 'Alpha', 'Bravo', '{"bestOf":3}'::jsonb
  );
  insert into public.courts (
    id, event_id, court_number, display_name, current_match_id,
    mode, status, frozen, scoring_open, preview_stream_path, program_stream_path
  ) values (
    retention_court_id, retention_event_id, 4, 'Retention Court', retention_match_id,
    'manual', 'live', false, true, 'court4_preview', 'court4_program'
  );
  score_row := public.community_ensure_score_projection(
    retention_event_id, retention_court_id, retention_match_id, 'PAUSED_DISPUTE'
  );
  insert into public.community_assignments (
    id, event_id, court_id, match_id, session_token_hash, display_name,
    role, trust_tier, status, authority_epoch, lease_expires_at
  ) values
    (
      cascade_assignment_id, retention_event_id, retention_court_id,
      retention_match_id, repeat('7', 64), 'Cascade fixture', 'OBSERVER',
      'REMOTE', 'ACTIVE', score_row.authority_epoch, clock_timestamp() + interval '5 minutes'
    ),
    (
      old_assignment_id, retention_event_id, retention_court_id,
      retention_match_id, repeat('8', 64), 'Retention fixture', 'OBSERVER',
      'REMOTE', 'ACTIVE', score_row.authority_epoch, clock_timestamp() + interval '5 minutes'
    );

  insert into public.community_playback_evidence (
    id, assignment_id, event_id, court_id, match_id, client_action_id,
    base_revision, action_type, team_side, evidence, recorded_at
  ) values
    (
      cascade_evidence_id, cascade_assignment_id, retention_event_id,
      retention_court_id, retention_match_id, gen_random_uuid()::text,
      0, 'ADD_POINT', 'A', '{}'::jsonb, clock_timestamp()
    ),
    (
      old_evidence_id, old_assignment_id, retention_event_id,
      retention_court_id, retention_match_id, gen_random_uuid()::text,
      0, 'ADD_POINT', 'B', '{}'::jsonb, clock_timestamp() - interval '8 days'
    );

  delete from public.community_assignments where id = cascade_assignment_id;
  if exists (select 1 from public.community_playback_evidence where id = cascade_evidence_id) then
    raise exception 'assignment cascade was blocked by playback evidence immutability';
  end if;

  insert into public.community_media_sessions (
    id, assignment_id, event_id, court_id, match_id, status,
    expires_at, closed_at, updated_at
  ) values (
    old_media_id, gen_random_uuid(), retention_event_id, retention_court_id,
    retention_match_id, 'FAILED', clock_timestamp() - interval '2 days',
    clock_timestamp() - interval '25 hours', clock_timestamp() - interval '25 hours'
  );
  prune_result := public.community_prune_media_history(100);
  if exists (select 1 from public.community_playback_evidence where id = old_evidence_id)
    or exists (select 1 from public.community_media_sessions where id = old_media_id)
    or (prune_result->>'playbackEvidenceDeleted')::integer < 1
    or (prune_result->>'mediaSessionsDeleted')::integer < 1 then
    raise exception 'bounded community media retention did not remove expired history: %', prune_result;
  end if;
end;
$community_media_retention$;

rollback;
