\set ON_ERROR_STOP on

-- Exact canonical bytes from the committed Python outbox-v2 / Ed25519 golden
-- fixture. The database boundary receives these bytes only after Node verifies
-- them; this fixture exercises persistence and read behavior, not cryptography.
\set golden_payload_base64 'eyJhZG9wdGVkX2FyY2hpdmVfZmluZ2VycHJpbnQiOiI5M2JiZmZmMWUxNTg3NjU3YjU1NDE3MjA1NjczM2YwNjY0ODY2YmM3YjEzNGUyNGE3MDQxMGIyYTZhOTI3MzY0IiwiYXBwZW5kZWRfYXRfbnMiOjE0MCwiYXV0aG9yaXphdGlvbl9yZWNvcmRfZmluZ2VycHJpbnQiOiI0ZDAwN2YzZGZlZDNmYzQ4YjczODgwMTM0MzY2MGJkNTM4YTJlNDAyZjgwNDIwZTE4ZGQxZWUxNjdmMzI5ZDNiIiwiZW52ZWxvcGVfZmluZ2VycHJpbnQiOiJmMDJiYzZmNmY2N2QwZDJjYmFkZmIyNmRlN2UzOWY3NzQ5ZWNkM2NlNzliNDhmNDA5ODkxNzUxYzdhNjRlODJlIiwiZXZlbnRfZmluZ2VycHJpbnQiOiI2ZTkxODZlOTg0ODAxZjU3NWM5MTE3ZGI5MmEwMzRlNDQ3NjlmZTk2NjcwOTdkMTI4ZjViNjVlZjBiZTkzZDFjIiwiZXZlbnRfaWQiOiJldmVudC1tYXRjaC0xLTEiLCJldmVudF9zdW1tYXJ5Ijp7ImRvbWFpbl9maWVsZHMiOnsic2VydmljZV9vcmRlcl9hIjpbImExIiwiYTIiXSwic2VydmljZV9vcmRlcl9iIjpbImIxIiwiYjIiXSwic2VydmluZ19wbGF5ZXIiOiJhMSIsInNlcnZpbmdfdGVhbSI6IkEiLCJzaWRlX2EiOiJORUFSIiwic2lkZV9iIjoiRkFSIn0sImV2ZW50X3R5cGUiOiJTRVRfU0VFRCIsImV2aWRlbmNlX2NvdW50IjowLCJldmlkZW5jZV9yZWZzX2ZpbmdlcnByaW50IjoiYjVjZmIwNTE1OGVmNTJmZDk3ZjBkNmIwZmUxNTVkZGJhMWI1YmJkNjg1YWI4ZGEwNTFkNzliNGYxZmZkZThjNiIsIm91dGNvbWUiOm51bGwsInJlcGxheV9yZWFzb24iOm51bGx9LCJtYXRjaF9pZCI6Im1hdGNoLTEiLCJtZXNzYWdlX2lkIjoic2hhZG93OjE6ZXZlbnQtbWF0Y2gtMS0xIiwib2ZmaWNpYWxfc2NvcmVjaGVja19tdXRhdGlvbl9wZXJtaXR0ZWQiOmZhbHNlLCJvdXRib3hfaWQiOjEsInBvc3Rfc3RhdGVfc3VtbWFyeSI6eyJjdXJyZW50X3NldCI6eyJudW1iZXIiOjEsInBoYXNlIjoiSU5fUFJPR1JFU1MiLCJzZXJ2aW5nX3BsYXllciI6ImExIiwic2VydmluZ190ZWFtIjoiQSIsInRlYW1fYV9wb2ludHMiOjAsInRlYW1fYl9wb2ludHMiOjB9LCJsYXN0X2NvbXBsZXRlZF9zZXQiOm51bGwsIm1hdGNoX3dpbm5lciI6bnVsbCwidGVhbV9hX3NldHMiOjAsInRlYW1fYl9zZXRzIjowfSwicmVkdWNlcl9idWlsZF9zaGEyNTYiOiJkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkZGRkIiwicmV2aWV3X2F1dGhvcml6YXRpb25fY29udGV4dF9maW5nZXJwcmludCI6bnVsbCwicmV2aWV3X2hpc3RvcnlfaGVhZF9zaGEyNTYiOiJmNWNkMWE0NDIwZjc0NjY1NTk3OGM3OTRlNjU1MGU2YzZlYWI0ODcxMTUyZDEwNDM5NDRmNmU1MGZjMTEyNzFlIiwicmV2aWV3X3Bvc2l0aW9uIjowLCJyZXZpc2lvbiI6MSwicnVsZXNldF9maW5nZXJwcmludCI6ImQ4MTRlMmU0NzYyYTc1NmVjYzRlM2I1NzAxMGMwYzM0NWFlZDE4YjAxNmJmZjM5NzkxYjUyZGFmMjdmNzIyYjQiLCJydWxlc2V0X2lkIjoiRklWQl9CRUFDSCIsInJ1bGVzZXRfdmVyc2lvbiI6IjIwMjUtMjAyOCIsInNjaGVtYV92ZXJzaW9uIjoiMi4wIiwic2NvcmVyX2NvcGlsb3RfY2FzZV9maW5nZXJwcmludCI6bnVsbCwic2NvcmVyX2NvcGlsb3RfY2FzZV9saW5rX2ZpbmdlcnByaW50IjpudWxsLCJzY29yZXJfY29waWxvdF9zaWduZWRfY2FzZV9maW5nZXJwcmludCI6bnVsbCwic3RhdGVfZmluZ2VycHJpbnQiOiIzNWRkYjMyY2MxNjkyNjQ1ZTEwZTI3NTAyZjE1ZDJmNzIwMTkyMzYwMDNlNjA5OWFhMWMxNzkwNDUwMTgxNjcxIiwidGFyZ2V0IjoiU0hBRE9XX09OTFlfTk9fT0ZGSUNJQUxfU0NPUkVDSEVDS19NVVRBVElPTiIsInRvcGljIjoidmlzaW9uX3Njb3Jpbmcuc2hhZG93LmF1dGhvcml6ZWRfZXZlbnQudjIifQ=='
\set golden_envelope_base64 'eyJhbGdvcml0aG0iOiJFZDI1NTE5IiwiYXR0ZW1wdF9pZCI6InB5dGhvbi1nb2xkZW4tMSIsImRpc3BhdGNoZXJfaWQiOiJkaXNwYXRjaGVyLTEiLCJkaXNwYXRjaGVyX2tleV9pZCI6ImRpc3BhdGNoLWtleS0xIiwiZXhwaXJlc19hdF9ucyI6MjUwLCJtZXNzYWdlX2lkIjoic2hhZG93OjE6ZXZlbnQtbWF0Y2gtMS0xIiwib3V0Ym94X2lkIjoxLCJwYXlsb2FkX2Jhc2U2NCI6ImV5SmhaRzl3ZEdWa1gyRnlZMmhwZG1WZlptbHVaMlZ5Y0hKcGJuUWlPaUk1TTJKaVptWm1NV1V4TlRnM05qVTNZalUxTkRFM01qQTFOamN6TTJZd05qWTBPRFkyWW1NM1lqRXpOR1V5TkdFM01EUXhNR0l5WVRaaE9USTNNelkwSWl3aVlYQndaVzVrWldSZllYUmZibk1pT2pFME1Dd2lZWFYwYUc5eWFYcGhkR2x2Ymw5eVpXTnZjbVJmWm1sdVoyVnljSEpwYm5RaU9pSTBaREF3TjJZelpHWmxaRE5tWXpRNFlqY3pPRGd3TVRNME16WTJNR0prTlRNNFlUSmxOREF5Wmpnd05ESXdaVEU0WkdReFpXVXhOamRtTXpJNVpETmlJaXdpWlc1MlpXeHZjR1ZmWm1sdVoyVnljSEpwYm5RaU9pSm1NREppWXpabU5tWTJOMlF3WkRKalltRmtabUl5Tm1SbE4yVXpPV1kzTnpRNVpXTmtNMk5sTnpsaU5EaG1OREE1T0RreE56VXhZemRoTmpSbE9ESmxJaXdpWlhabGJuUmZabWx1WjJWeWNISnBiblFpT2lJMlpUa3hPRFpsT1RnME9EQXhaalUzTldNNU1URTNaR0k1TW1Fd016UmxORFEzTmpsbVpUazJOamN3T1Rka01USTRaalZpTmpWbFpqQmlaVGt6WkRGaklpd2laWFpsYm5SZmFXUWlPaUpsZG1WdWRDMXRZWFJqYUMweExURWlMQ0psZG1WdWRGOXpkVzF0WVhKNUlqcDdJbVJ2YldGcGJsOW1hV1ZzWkhNaU9uc2ljMlZ5ZG1salpWOXZjbVJsY2w5aElqcGJJbUV4SWl3aVlUSWlYU3dpYzJWeWRtbGpaVjl2Y21SbGNsOWlJanBiSW1JeElpd2lZaklpWFN3aWMyVnlkbWx1WjE5d2JHRjVaWElpT2lKaE1TSXNJbk5sY25acGJtZGZkR1ZoYlNJNklrRWlMQ0p6YVdSbFgyRWlPaUpPUlVGU0lpd2ljMmxrWlY5aUlqb2lSa0ZTSW4wc0ltVjJaVzUwWDNSNWNHVWlPaUpUUlZSZlUwVkZSQ0lzSW1WMmFXUmxibU5sWDJOdmRXNTBJam93TENKbGRtbGtaVzVqWlY5eVpXWnpYMlpwYm1kbGNuQnlhVzUwSWpvaVlqVmpabUl3TlRFMU9HVm1OVEptWkRrM1pqQmtObUl3Wm1VeE5UVmtaR0poTVdJMVltSmtOamcxWVdJNFpHRXdOVEZrTnpsaU5HWXhabVprWlRoak5pSXNJbTkxZEdOdmJXVWlPbTUxYkd3c0luSmxjR3hoZVY5eVpXRnpiMjRpT201MWJHeDlMQ0p0WVhSamFGOXBaQ0k2SW0xaGRHTm9MVEVpTENKdFpYTnpZV2RsWDJsa0lqb2ljMmhoWkc5M09qRTZaWFpsYm5RdGJXRjBZMmd0TVMweElpd2liMlptYVdOcFlXeGZjMk52Y21WamFHVmphMTl0ZFhSaGRHbHZibDl3WlhKdGFYUjBaV1FpT21aaGJITmxMQ0p2ZFhSaWIzaGZhV1FpT2pFc0luQnZjM1JmYzNSaGRHVmZjM1Z0YldGeWVTSTZleUpqZFhKeVpXNTBYM05sZENJNmV5SnVkVzFpWlhJaU9qRXNJbkJvWVhObElqb2lTVTVmVUZKUFIxSkZVMU1pTENKelpYSjJhVzVuWDNCc1lYbGxjaUk2SW1FeElpd2ljMlZ5ZG1sdVoxOTBaV0Z0SWpvaVFTSXNJblJsWVcxZllWOXdiMmx1ZEhNaU9qQXNJblJsWVcxZllsOXdiMmx1ZEhNaU9qQjlMQ0pzWVhOMFgyTnZiWEJzWlhSbFpGOXpaWFFpT201MWJHd3NJbTFoZEdOb1gzZHBibTVsY2lJNmJuVnNiQ3dpZEdWaGJWOWhYM05sZEhNaU9qQXNJblJsWVcxZllsOXpaWFJ6SWpvd2ZTd2ljbVZrZFdObGNsOWlkV2xzWkY5emFHRXlOVFlpT2lKa1pHUmtaR1JrWkdSa1pHUmtaR1JrWkdSa1pHUmtaR1JrWkdSa1pHUmtaR1JrWkdSa1pHUmtaR1JrWkdSa1pHUmtaR1JrWkdSa1pHUmtaR1JrWkdSa0lpd2ljbVYyYVdWM1gyRjFkR2h2Y21sNllYUnBiMjVmWTI5dWRHVjRkRjltYVc1blpYSndjbWx1ZENJNmJuVnNiQ3dpY21WMmFXVjNYMmhwYzNSdmNubGZhR1ZoWkY5emFHRXlOVFlpT2lKbU5XTmtNV0UwTkRJd1pqYzBOalkxTlRrM09HTTNPVFJsTmpVMU1HVTJZelpsWVdJME9EY3hNVFV5WkRFd05ETTVORFJtTm1VMU1HWmpNVEV5TnpGbElpd2ljbVYyYVdWM1gzQnZjMmwwYVc5dUlqb3dMQ0p5WlhacGMybHZiaUk2TVN3aWNuVnNaWE5sZEY5bWFXNW5aWEp3Y21sdWRDSTZJbVE0TVRSbE1tVTBOell5WVRjMU5tVmpZelJsTTJJMU56QXhNR013WXpNME5XRmxaREU0WWpBeE5tSm1aak01TnpreFlqVXlaR0ZtTWpkbU56SXlZalFpTENKeWRXeGxjMlYwWDJsa0lqb2lSa2xXUWw5Q1JVRkRTQ0lzSW5KMWJHVnpaWFJmZG1WeWMybHZiaUk2SWpJd01qVXRNakF5T0NJc0luTmphR1Z0WVY5MlpYSnphVzl1SWpvaU1pNHdJaXdpYzJOdmNtVnlYMk52Y0dsc2IzUmZZMkZ6WlY5bWFXNW5aWEp3Y21sdWRDSTZiblZzYkN3aWMyTnZjbVZ5WDJOdmNHbHNiM1JmWTJGelpWOXNhVzVyWDJacGJtZGxjbkJ5YVc1MElqcHVkV3hzTENKelkyOXlaWEpmWTI5d2FXeHZkRjl6YVdkdVpXUmZZMkZ6WlY5bWFXNW5aWEp3Y21sdWRDSTZiblZzYkN3aWMzUmhkR1ZmWm1sdVoyVnljSEpwYm5RaU9pSXpOV1JrWWpNeVkyTXhOamt5TmpRMVpURXdaVEkzTlRBeVpqRTFaREptTnpJd01Ua3lNell3TURObE5qQTVPV0ZoTVdNeE56a3dORFV3TVRneE5qY3hJaXdpZEdGeVoyVjBJam9pVTBoQlJFOVhYMDlPVEZsZlRrOWZUMFpHU1VOSlFVeGZVME5QVWtWRFNFVkRTMTlOVlZSQlZFbFBUaUlzSW5SdmNHbGpJam9pZG1semFXOXVYM05qYjNKcGJtY3VjMmhoWkc5M0xtRjFkR2h2Y21sNlpXUmZaWFpsYm5RdWRqSWlmUT09IiwicGF5bG9hZF9zaGEyNTYiOiI0ZWY2MTk2Y2IyZWJlZmQxYzU0MjI1MGY0ODYwYWFiMjdkNzkwZjE3MDA1NjYwMjM4ODljZWM5ZjM5MTA1MjBlIiwic2NoZW1hX3ZlcnNpb24iOiIxLjAiLCJzaWduYXR1cmVfYmFzZTY0IjoiQ1Y5Zk41VnJyV2dEMXhhVzI0TENwcFdlUnE0RUZuTHFBRCtQeFh4dU16VUtWNmF0Vm5BNGlYZTVUNWtoUlhMQVRWNmFhYkRjMG51VCtiTEdvL2tzQ3c9PSIsInNpZ25lZF9hdF9ucyI6MjAwLCJzb3VyY2VfbGVkZ2VyX2lkIjoibGVkZ2VyLTEifQ=='

select set_config('vision_test.golden_payload_base64', :'golden_payload_base64', false);
select set_config('vision_test.golden_envelope_base64', :'golden_envelope_base64', false);

do $$
begin
  if current_setting('server_version_num')::integer / 10000 <> 15 then
    raise exception 'fixture requires PostgreSQL 15, got %', version();
  end if;
end
$$;

-- Model the explicit table INSERT grants Supabase gives service_role. These
-- are intentionally test-scoped and do not grant direct vision-table access.
grant usage on schema public to service_role;
grant insert on public.events, public.matches, public.courts, public.overlay_states
  to service_role;

-- Inventory every live public-table default that depends on a public-schema
-- function. Any such function must remain executable by the production-like
-- insertion principal after the vision proposal removes ambient PUBLIC EXECUTE.
select
  table_namespace.nspname as table_schema,
  table_object.relname as table_name,
  table_attribute.attname as column_name,
  function_namespace.nspname as function_schema,
  function_object.proname as function_name
from pg_attrdef default_expression
join pg_class table_object on table_object.oid = default_expression.adrelid
join pg_namespace table_namespace on table_namespace.oid = table_object.relnamespace
join pg_attribute table_attribute
  on table_attribute.attrelid = table_object.oid and
     table_attribute.attnum = default_expression.adnum
join pg_depend dependency
  on dependency.classid = 'pg_attrdef'::regclass and
     dependency.objid = default_expression.oid and
     dependency.refclassid = 'pg_proc'::regclass
join pg_proc function_object on function_object.oid = dependency.refobjid
join pg_namespace function_namespace on function_namespace.oid = function_object.pronamespace
where table_namespace.nspname = 'public'
  and function_namespace.nspname = 'public'
order by table_object.relname, table_attribute.attnum, function_object.proname;

do $$
begin
  if exists (
    select 1
    from pg_attrdef default_expression
    join pg_class table_object on table_object.oid = default_expression.adrelid
    join pg_namespace table_namespace on table_namespace.oid = table_object.relnamespace
    join pg_depend dependency
      on dependency.classid = 'pg_attrdef'::regclass and
         dependency.objid = default_expression.oid and
         dependency.refclassid = 'pg_proc'::regclass
    join pg_proc function_object on function_object.oid = dependency.refobjid
    join pg_namespace function_namespace
      on function_namespace.oid = function_object.pronamespace
    where table_namespace.nspname = 'public'
      and function_namespace.nspname = 'public'
      and not has_function_privilege('service_role', function_object.oid, 'EXECUTE')
  ) then
    raise exception 'vision proposal stranded a live public-function column default';
  end if;
end
$$;

set role service_role;
-- Omit the ID and all optional values to exercise current-schema defaults.
insert into public.events(name) values ('Service role default probe');
insert into public.events(id, name, status)
values ('11111111-1111-4111-8111-111111111111', 'Vision integration', 'active');
insert into public.matches(id, event_id, api_url, status)
values (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  'https://integration.invalid/match-1',
  'live'
);
insert into public.courts(
  id,
  event_id,
  court_number,
  display_name,
  current_match_id,
  preview_stream_path,
  program_stream_path
) values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  1,
  'Integration Court',
  '33333333-3333-4333-8333-333333333333',
  'integration_preview',
  'integration_program'
);
insert into public.overlay_states(court_id, event_id, court_number, payload)
values (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  1,
  '{"source":"vision-integration"}'::jsonb
);
reset role;

do $$
begin
  if (select count(*) from public.events where name = 'Service role default probe') <> 1 then
    raise exception 'service_role could not perform a current-schema default insert';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'broadcast_overlay_state_change_trigger' and not tgisinternal
  ) then
    raise exception 'migration 002 broadcast trigger was not created';
  end if;
  if (
    select count(*) from realtime.send_log
    where event_name = 'overlay_state' and
          topic = 'overlay:11111111-1111-4111-8111-111111111111:court:1' and
          payload = '{"source":"vision-integration"}'::jsonb
  ) <> 1 then
    raise exception 'broadcast trigger did not call the realtime.send stub after the vision proposal';
  end if;
end
$$;

set role vision_shadow_binding_publisher;
select public.vision_publish_match_binding(
  'ledger-1',
  'match-1',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  100,
  repeat('a', 64),
  90
);
do $$
begin
  perform public.vision_publish_match_binding(
    'ledger-1',
    'match-1',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    100,
    repeat('a', 64),
    90
  );
  raise exception 'immutable binding unexpectedly accepted a rebind';
exception
  when unique_violation then null;
end
$$;
reset role;

set role vision_shadow_ingest;
do $$
declare
  v_code text;
  v_detail text;
begin
  select result_code, result_detail into strict v_code, v_detail
  from public.vision_accept_shadow_receipt(
    decode(current_setting('vision_test.golden_envelope_base64'), 'base64'),
    decode(current_setting('vision_test.golden_payload_base64'), 'base64'),
    220
  );
  if v_code is distinct from 'INSERTED' or v_detail is not null then
    raise exception 'golden receipt insert returned %, %', v_code, v_detail;
  end if;

  select result_code, result_detail into strict v_code, v_detail
  from public.vision_accept_shadow_receipt(
    decode(current_setting('vision_test.golden_envelope_base64'), 'base64'),
    decode(current_setting('vision_test.golden_payload_base64'), 'base64'),
    220
  );
  if v_code is distinct from 'EXACT_RETRY' or v_detail is not null then
    raise exception 'golden receipt retry returned %, %', v_code, v_detail;
  end if;
end
$$;
reset role;

set role vision_shadow_reader;
do $$
declare
  v_total integer;
  v_meta integer;
  v_receipts integer;
  v_receipt_contract boolean;
begin
  select
    count(*)::integer,
    count(*) filter (
      where record ->> 'row_kind' = 'META' and
            record -> 'integrity_block_code' = 'null'::jsonb
    )::integer,
    count(*) filter (where record ->> 'row_kind' = 'RECEIPT')::integer,
    coalesce(bool_and(
      jsonb_typeof(record -> 'outbox_id') = 'string' and
      jsonb_typeof(record -> 'source_revision') = 'string' and
      jsonb_typeof(record #> '{event_summary,evidence_count}') = 'string' and
      jsonb_typeof(record #> '{post_state_summary,current_set,number}') = 'string' and
      record #>> '{event_summary,evidence_count}' = '0' and
      record #>> '{post_state_summary,current_set,number}' = '1' and
      not record ? 'binding_generation' and
      not record ? 'scorecheck_event_id' and
      not record ? 'scorecheck_court_id' and
      not record ? 'scorecheck_match_id'
    ) filter (where record ->> 'row_kind' = 'RECEIPT'), false)
  into v_total, v_meta, v_receipts, v_receipt_contract
  from public.vision_read_shadow_receipts('ledger-1', 'match-1');
  if v_total <> 2 or v_meta <> 1 or v_receipts <> 1 or not v_receipt_contract then
    raise exception 'fixed read did not return the exact META + RECEIPT contract';
  end if;
end
$$;
reset role;

do $$
begin
  update public.vision_shadow_receipts set received_at_ns = received_at_ns + 1;
  raise exception 'append-only receipt unexpectedly accepted an update';
exception
  when sqlstate '55000' then null;
end
$$;

grant select on public.vision_shadow_receipts to vision_shadow_reader;
set role vision_shadow_reader;
do $$
declare
  v_visible bigint;
begin
  select count(*) into v_visible from public.vision_shadow_receipts;
  if v_visible <> 0 then
    raise exception 'RLS exposed % receipt rows after an accidental SELECT grant', v_visible;
  end if;
end
$$;
reset role;
revoke select on public.vision_shadow_receipts from vision_shadow_reader;

-- Build a structurally valid but conflicting receipt as the database owner.
-- Its signature is deliberately not re-used as an authentication assertion:
-- Node owns that check, while this branch tests terminal identity handling.
with altered_payload as (
  select convert_to(
    jsonb_set(
      convert_from(
        decode(current_setting('vision_test.golden_payload_base64'), 'base64'),
        'UTF8'
      )::jsonb,
      '{state_fingerprint}',
      to_jsonb(repeat('4', 64)),
      false
    )::text,
    'UTF8'
  ) as bytes
), altered_envelope as (
  select
    altered_payload.bytes as payload_bytes,
    convert_to(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            convert_from(
              decode(current_setting('vision_test.golden_envelope_base64'), 'base64'),
              'UTF8'
            )::jsonb,
            '{attempt_id}',
            to_jsonb('database-conflict-fixture'::text),
            false
          ),
          '{payload_base64}',
          to_jsonb(replace(encode(altered_payload.bytes, 'base64'), E'\n', '')),
          false
        ),
        '{payload_sha256}',
        to_jsonb(encode(digest(altered_payload.bytes, 'sha256'), 'hex')),
        false
      )::text,
      'UTF8'
    ) as envelope_bytes
  from altered_payload
)
select
  set_config(
    'vision_test.conflict_payload_base64',
    replace(encode(payload_bytes, 'base64'), E'\n', ''),
    false
  ),
  set_config(
    'vision_test.conflict_envelope_base64',
    replace(encode(envelope_bytes, 'base64'), E'\n', ''),
    false
  )
from altered_envelope;

set role vision_shadow_ingest;
do $$
declare
  v_code text;
  v_detail text;
begin
  select result_code, result_detail into strict v_code, v_detail
  from public.vision_accept_shadow_receipt(
    decode(current_setting('vision_test.conflict_envelope_base64'), 'base64'),
    decode(current_setting('vision_test.conflict_payload_base64'), 'base64'),
    220
  );
  if v_code is distinct from 'INTEGRITY_BLOCKED' or
     v_detail is distinct from 'IDENTITY_CONFLICT' then
    raise exception 'conflicting receipt returned %, %', v_code, v_detail;
  end if;

  select result_code, result_detail into strict v_code, v_detail
  from public.vision_accept_shadow_receipt(
    decode(current_setting('vision_test.golden_envelope_base64'), 'base64'),
    decode(current_setting('vision_test.golden_payload_base64'), 'base64'),
    220
  );
  if v_code is distinct from 'SOURCE_BLOCKED' or
     v_detail is distinct from 'TERMINAL_INTEGRITY_BLOCK' then
    raise exception 'terminally blocked source returned %, %', v_code, v_detail;
  end if;
end
$$;
reset role;

set role vision_shadow_reader;
do $$
declare
  v_total integer;
  v_blocked_meta integer;
  v_verified_prefix integer;
begin
  select
    count(*)::integer,
    count(*) filter (
      where record ->> 'row_kind' = 'META' and
            record ->> 'integrity_block_code' = 'IDENTITY_CONFLICT'
    )::integer,
    count(*) filter (
      where record ->> 'row_kind' = 'RECEIPT' and
            record ->> 'payload_sha256' =
              '4ef6196cb2ebefd1c542250f4860aab27d790f1700566023889cec9f3910520e'
    )::integer
  into v_total, v_blocked_meta, v_verified_prefix
  from public.vision_read_shadow_receipts('ledger-1', 'match-1');
  if v_total <> 2 or v_blocked_meta <> 1 or v_verified_prefix <> 1 then
    raise exception 'terminal block did not preserve the fixed read prefix';
  end if;
end
$$;
reset role;

do $$
begin
  if (select count(*) from public.score_states) <> 0 then
    raise exception 'vision integration mutated official score state';
  end if;
end
$$;
