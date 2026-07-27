-- 031: Buffered HLS adds its measured playout latency to the commentary
-- synchronization target. Preserve the 0-10 second human fallback setting on
-- courts, while allowing the runtime heartbeat to report the full 30-second
-- program timeline used by the browser audio graph.

alter table public.program_heartbeats
  drop constraint if exists program_heartbeats_commentary_delay_configured_ms_check,
  drop constraint if exists program_heartbeats_commentary_delay_target_ms_check,
  drop constraint if exists program_heartbeats_commentary_delay_applied_ms_check;

alter table public.program_heartbeats
  add constraint program_heartbeats_commentary_delay_configured_ms_check
    check (commentary_delay_configured_ms between 0 and 30000),
  add constraint program_heartbeats_commentary_delay_target_ms_check
    check (commentary_delay_target_ms between 0 and 30000),
  add constraint program_heartbeats_commentary_delay_applied_ms_check
    check (commentary_delay_applied_ms between 0 and 30000);

comment on column public.program_heartbeats.commentary_delay_configured_ms is
  'Fallback commentary delay including the buffered program timeline, from 0 to 30000 ms.';
comment on column public.program_heartbeats.commentary_delay_target_ms is
  'Current measured commentary synchronization target, from 0 to 30000 ms.';
comment on column public.program_heartbeats.commentary_delay_applied_ms is
  'Current slew-limited DelayNode value, from 0 to 30000 ms.';
