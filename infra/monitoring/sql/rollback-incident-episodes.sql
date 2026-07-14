\set ON_ERROR_STOP on

-- This rollback is intentionally non-destructive. It succeeds only before any
-- fingerprint has multiple durable episodes. After that boundary, restore the
-- pre-migration database backup or ship a forward fix instead of deleting
-- incident history.
begin;

do $$
begin
  if exists (
    select 1
    from public.monitoring_incidents
    group by fingerprint
    having count(*) > 1
  ) then
    raise exception 'rollback refused: recurring incident episodes already exist';
  end if;
end;
$$;

drop function if exists public.monitoring_incident_episode_contract();
drop index if exists public.monitoring_incidents_active_fingerprint_key;

alter table public.monitoring_incidents
  add constraint monitoring_incidents_fingerprint_key unique (fingerprint);

commit;
