-- Focused executable checks for the Community Witness canonical score reducer.
-- Run after local migrations:
--   docker exec -i supabase_db_web psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     -f /dev/stdin < supabase/tests/community_witness_reducer.sql

do $$
declare
  base_state jsonb := jsonb_build_object(
    'teamAScore', 0,
    'teamBScore', 0,
    'teamASets', 0,
    'teamBSets', 0,
    'currentSet', 1,
    'setScores', '[]'::jsonb,
    'servingTeam', null,
    'timeouts', '{}'::jsonb,
    'status', 'Pre-Match',
    'currentRallyNumber', 0
  );
  standard_format jsonb := jsonb_build_object(
    'bestOf', 3,
    'setsToWin', 2,
    'pointsPerSet', jsonb_build_array(21, 21, 15),
    'winByTwo', true,
    'cap', null
  );
  result jsonb;
begin
  -- A set-winning point records history and immediately advances to the next set.
  result := public.community_reduce_score_action(
    base_state || jsonb_build_object(
      'teamAScore', 20,
      'teamBScore', 10,
      'status', 'In Progress',
      'currentRallyNumber', 30
    ),
    '{"type":"ADD_POINT","team":"A"}'::jsonb,
    standard_format
  );
  if result->>'status' <> 'In Progress'
    or (result->>'currentSet')::integer <> 2
    or (result->>'teamAScore')::integer <> 0
    or (result->>'teamBScore')::integer <> 0
    or (result->>'teamASets')::integer <> 1
    or result->'setScores'->0 <> '{"setNumber":1,"teamAScore":21,"teamBScore":10,"isComplete":true}'::jsonb
    or (result->>'currentRallyNumber')::integer <> 31 then
    raise exception 'set-winning ADD_POINT did not advance atomically: %', result;
  end if;

  -- A deciding-set point completes the match and leaves the final score visible.
  result := public.community_reduce_score_action(
    base_state || jsonb_build_object(
      'teamAScore', 14,
      'teamBScore', 10,
      'teamASets', 1,
      'teamBSets', 1,
      'currentSet', 3,
      'status', 'In Progress'
    ),
    '{"type":"ADD_POINT","team":"A"}'::jsonb,
    standard_format
  );
  if result->>'status' <> 'Final'
    or (result->>'teamAScore')::integer <> 15
    or (result->>'teamBScore')::integer <> 10
    or (result->>'teamASets')::integer <> 2 then
    raise exception 'deciding set did not complete the match: %', result;
  end if;

  -- Win-by-two blocks a 21-20 completion.
  result := public.community_reduce_score_action(
    base_state || jsonb_build_object(
      'teamAScore', 20,
      'teamBScore', 20,
      'status', 'In Progress'
    ),
    '{"type":"ADD_POINT","team":"A"}'::jsonb,
    standard_format
  );
  if result->>'status' <> 'In Progress'
    or (result->>'teamAScore')::integer <> 21
    or (result->>'teamBScore')::integer <> 20
    or (result->>'teamASets')::integer <> 0 then
    raise exception 'win-by-two was not enforced: %', result;
  end if;

  -- A configured cap wins even when the lead is only one point.
  result := public.community_reduce_score_action(
    base_state || jsonb_build_object(
      'teamAScore', 22,
      'teamBScore', 22,
      'status', 'In Progress'
    ),
    '{"type":"ADD_POINT","team":"A"}'::jsonb,
    standard_format || '{"cap":23}'::jsonb
  );
  if (result->>'currentSet')::integer <> 2
    or (result->>'teamASets')::integer <> 1
    or result->'setScores'->0->>'teamAScore' <> '23'
    or result->'setScores'->0->>'teamBScore' <> '22' then
    raise exception 'set cap was not honored: %', result;
  end if;

  -- Best-of-five set three still targets 21, not deciding-set 15.
  result := public.community_reduce_score_action(
    base_state || jsonb_build_object(
      'teamAScore', 14,
      'teamBScore', 10,
      'teamASets', 1,
      'teamBSets', 1,
      'currentSet', 3,
      'status', 'In Progress'
    ),
    '{"type":"ADD_POINT","team":"A"}'::jsonb,
    '{"bestOf":5,"pointsPerSet":[21,21,21,21,15],"winByTwo":true}'::jsonb
  );
  if result->>'status' <> 'In Progress'
    or (result->>'currentSet')::integer <> 3
    or (result->>'teamAScore')::integer <> 15
    or (result->>'teamASets')::integer <> 1 then
    raise exception 'best-of-five target/set threshold fallback is wrong: %', result;
  end if;

  -- Removing the winning point at a freshly advanced 0-0 reopens the prior set.
  result := public.community_reduce_score_action(
    base_state || jsonb_build_object(
      'teamASets', 1,
      'currentSet', 2,
      'setScores', '[{"setNumber":1,"teamAScore":21,"teamBScore":19,"isComplete":true}]'::jsonb,
      'status', 'In Progress'
    ),
    '{"type":"REMOVE_POINT","team":"A"}'::jsonb,
    standard_format
  );
  if result->>'status' <> 'In Progress'
    or (result->>'currentSet')::integer <> 1
    or (result->>'teamAScore')::integer <> 20
    or (result->>'teamBScore')::integer <> 19
    or (result->>'teamASets')::integer <> 0
    or jsonb_array_length(result->'setScores') <> 0 then
    raise exception 'winning-point removal did not reopen the prior set: %', result;
  end if;

  -- Removing a losing-team point keeps a still-valid completed set advanced.
  result := public.community_reduce_score_action(
    base_state || jsonb_build_object(
      'teamASets', 1,
      'currentSet', 2,
      'setScores', '[{"setNumber":1,"teamAScore":21,"teamBScore":10,"isComplete":true}]'::jsonb,
      'status', 'In Progress'
    ),
    '{"type":"REMOVE_POINT","team":"B"}'::jsonb,
    standard_format
  );
  if (result->>'currentSet')::integer <> 2
    or (result->>'teamAScore')::integer <> 0
    or (result->>'teamBScore')::integer <> 0
    or (result->>'teamASets')::integer <> 1
    or result->'setScores'->0->>'teamBScore' <> '9' then
    raise exception 'valid completed-set correction did not preserve advancement: %', result;
  end if;

  -- Removing a final winning point can reopen the deciding set and the match.
  result := public.community_reduce_score_action(
    base_state || jsonb_build_object(
      'teamAScore', 15,
      'teamBScore', 13,
      'teamASets', 2,
      'teamBSets', 1,
      'currentSet', 3,
      'setScores', '[{"setNumber":3,"teamAScore":15,"teamBScore":13,"isComplete":true}]'::jsonb,
      'status', 'Final'
    ),
    '{"type":"REMOVE_POINT","team":"A"}'::jsonb,
    standard_format
  );
  if result->>'status' <> 'In Progress'
    or (result->>'currentSet')::integer <> 3
    or (result->>'teamAScore')::integer <> 14
    or (result->>'teamBScore')::integer <> 13
    or (result->>'teamASets')::integer <> 1
    or jsonb_array_length(result->'setScores') <> 0 then
    raise exception 'final winning-point correction did not reopen the match: %', result;
  end if;

  -- A correction that leaves the final set legally complete stays Final.
  result := public.community_reduce_score_action(
    base_state || jsonb_build_object(
      'teamAScore', 23,
      'teamBScore', 10,
      'teamASets', 2,
      'teamBSets', 1,
      'currentSet', 3,
      'setScores', '[{"setNumber":3,"teamAScore":23,"teamBScore":10,"isComplete":true}]'::jsonb,
      'status', 'Final'
    ),
    '{"type":"REMOVE_POINT","team":"A"}'::jsonb,
    standard_format
  );
  if result->>'status' <> 'Final'
    or (result->>'teamAScore')::integer <> 22
    or (result->>'teamBScore')::integer <> 10
    or (result->>'teamASets')::integer <> 2
    or result->'setScores'->0->>'teamAScore' <> '22' then
    raise exception 'still-valid final correction should remain Final: %', result;
  end if;
end;
$$;
