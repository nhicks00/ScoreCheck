\set ON_ERROR_STOP on

-- This rollback broadens the provider constraint without deleting or rewriting
-- notification history. It refuses to run unless the exact migration-029
-- contract and ledger entry are present.
begin;

do $$
begin
  if exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '029'
      and name <> 'monitoring_pushover_only'
  ) then
    raise exception 'rollback refused: migration version 029 has a different name';
  end if;

  if not exists (
    select 1
    from supabase_migrations.schema_migrations
    where version = '029'
      and name = 'monitoring_pushover_only'
  ) then
    raise exception 'rollback refused: migration 029 is not applied';
  end if;
end;
$$;

create temporary table incident_notifications_provider_probe
  (like public.incident_notifications including defaults including constraints);

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
    raise exception 'rollback refused: current constraint accepts a non-Pushover provider';
  exception when check_violation then
    null;
  end;
end;
$$;

alter table public.incident_notifications
  drop constraint if exists incident_notifications_provider_check;

alter table public.incident_notifications
  add constraint incident_notifications_provider_check
  check (provider in ('pushover', 'twilio_sms', 'twilio_voice', 'external'));

delete from supabase_migrations.schema_migrations
where version = '029'
  and name = 'monitoring_pushover_only';

commit;
