\set ON_ERROR_STOP on

begin;

do $$
begin
  if exists (
    select 1
    from public.incident_notifications
    where provider <> 'pushover'
  ) then
    raise exception 'non-Pushover notification history exists';
  end if;

  if not exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '029'
      and name = 'monitoring_pushover_only'
  ) then
    raise exception 'migration 029 is missing from the migration ledger';
  end if;
end;
$$;

create temporary table incident_notifications_provider_probe
  (like public.incident_notifications including defaults including constraints);

insert into incident_notifications_provider_probe (
  incident_id,
  provider,
  status,
  submitted_at,
  updated_at
) values (
  gen_random_uuid(),
  'pushover',
  'pending',
  now(),
  now()
);

do $$
begin
  begin
    insert into incident_notifications_provider_probe (
      incident_id,
      provider,
      status,
      submitted_at,
      updated_at
    ) values (
      gen_random_uuid(),
      'external',
      'pending',
      now(),
      now()
    );
    raise exception 'non-Pushover provider was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

rollback;
