\set ON_ERROR_STOP on

begin;

do $$
begin
  if public.monitoring_incident_episode_contract() <> 1 then
    raise exception 'monitoring incident episode contract is not installed';
  end if;
end;
$$;

insert into public.monitoring_incidents (
  id, fingerprint, stage, issue_code, severity, status, confidence,
  summary, evidence, opened_at, last_observed_at, resolved_at
) values
  ('00000000-0000-4000-8000-000000000901', '__episode_contract_probe__', 'MONITORING', 'PROBE', 'info', 'resolved', 'high', 'probe', '{}', now() - interval '4 minutes', now() - interval '3 minutes', now() - interval '3 minutes'),
  ('00000000-0000-4000-8000-000000000902', '__episode_contract_probe__', 'MONITORING', 'PROBE', 'info', 'resolved', 'high', 'probe', '{}', now() - interval '2 minutes', now() - interval '1 minute', now() - interval '1 minute'),
  ('00000000-0000-4000-8000-000000000903', '__episode_contract_probe__', 'MONITORING', 'PROBE', 'info', 'open', 'high', 'probe', '{}', now(), now(), null);

do $$
begin
  begin
    insert into public.monitoring_incidents (
      id, fingerprint, stage, issue_code, severity, status, confidence,
      summary, evidence, opened_at, last_observed_at
    ) values (
      '00000000-0000-4000-8000-000000000904', '__episode_contract_probe__',
      'MONITORING', 'PROBE', 'info', 'open', 'high', 'probe', '{}', now(), now()
    );
    raise exception 'partial active-fingerprint uniqueness was not enforced';
  exception when unique_violation then
    null;
  end;
end;
$$;

rollback;
