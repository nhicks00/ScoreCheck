-- 012: Program page heartbeats.
-- /program/court/{n} — the compositor scene a headless-Chrome LiveKit egress
-- captures and pushes to YouTube (docs/PRODUCTION_PLATFORM_PLAN.md §3.1) —
-- POSTs its self-reported health to /api/program/heartbeat every 5 seconds.
-- One row per court, upserted in place, so the production console can alarm
-- on stale last_seen_at and semantic video state instead of just
-- "Chrome is running".

create table if not exists public.program_heartbeats (
  court_number int primary key,
  last_seen_at timestamptz not null,
  video_state text,
  frames_rendered bigint,
  commentary_loaded boolean,
  page_version text
);

comment on table public.program_heartbeats is
  'Latest self-reported health per program page (/program/court/{n}); upserted every 5s by /api/program/heartbeat.';
comment on column public.program_heartbeats.last_seen_at is
  'Server time of the most recent heartbeat; staleness beyond ~15s means the page (or its Chrome) is gone.';
comment on column public.program_heartbeats.video_state is
  'Page-reported playback state: waiting | playing | stalled | reconnecting | reloading | fatal.';
comment on column public.program_heartbeats.frames_rendered is
  'Total decoded video frames reported by the page (getVideoPlaybackQuality().totalVideoFrames).';
comment on column public.program_heartbeats.commentary_loaded is
  'Whether the hidden VDO.Ninja commentary iframe has loaded.';
comment on column public.program_heartbeats.page_version is
  'Build version (git commit sha) of the page — same pattern as /api/overlay/version.';
