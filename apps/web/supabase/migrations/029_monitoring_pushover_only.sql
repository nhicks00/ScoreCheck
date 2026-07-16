-- Hard-cut monitoring notifications to the sole production provider.
-- Abort rather than discard or reinterpret incompatible notification history.
do $$
begin
  if exists (
    select 1
    from public.incident_notifications
    where provider <> 'pushover'
  ) then
    raise exception using
      errcode = '23514',
      message = 'incident_notifications contains a non-Pushover provider';
  end if;
end
$$;

alter table public.incident_notifications
  drop constraint if exists incident_notifications_provider_check;

alter table public.incident_notifications
  add constraint incident_notifications_provider_check
  check (provider = 'pushover');

comment on constraint incident_notifications_provider_check
  on public.incident_notifications is
  'ScoreCheck monitoring pages exclusively through Pushover.';
