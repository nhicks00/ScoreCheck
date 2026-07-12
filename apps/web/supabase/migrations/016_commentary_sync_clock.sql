-- 016: Runtime diagnostics for the adaptive commentary synchronization clock.

alter table public.courts
  alter column commentary_delay_ms set default 3000;

update public.courts
set commentary_delay_ms = greatest(0, least(10000, program_video_delay_ms - 500))
where commentary_delay_ms = 0
  and program_video_delay_ms > 0;

alter table public.program_heartbeats
  add column commentary_sync_status text
    check (commentary_sync_status in ('fallback', 'calibrating', 'locked')),
  add column commentary_delay_configured_ms numeric
    check (commentary_delay_configured_ms between 0 and 10000),
  add column commentary_delay_target_ms numeric
    check (commentary_delay_target_ms between 0 and 10000),
  add column commentary_delay_applied_ms numeric
    check (commentary_delay_applied_ms between 0 and 10000),
  add column commentary_sync_rtt_ms numeric
    check (commentary_sync_rtt_ms between 0 and 60000),
  add column commentary_sync_sample_age_ms numeric
    check (commentary_sync_sample_age_ms between 0 and 60000);

comment on column public.program_heartbeats.commentary_sync_status is
  'Adaptive commentary clock state: fallback, calibrating, or locked.';
comment on column public.program_heartbeats.commentary_delay_configured_ms is
  'Human-calibrated baseline delay loaded from the active court.';
comment on column public.program_heartbeats.commentary_delay_target_ms is
  'Current transport-corrected delay target computed by the program mixer.';
comment on column public.program_heartbeats.commentary_delay_applied_ms is
  'Current slew-limited DelayNode value applied to commentary tracks.';
comment on column public.program_heartbeats.commentary_sync_rtt_ms is
  'Best recent NTP-style LiveKit data-channel round-trip measurement.';
comment on column public.program_heartbeats.commentary_sync_sample_age_ms is
  'Age of the latest preview timing anchor after remote clock correction.';
