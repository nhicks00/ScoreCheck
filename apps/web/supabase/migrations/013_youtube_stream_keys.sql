-- 013: Per-court YouTube stream keys.
-- StreamRun held these in its UI; the production platform stores them on the
-- court row so the ops console (/admin/production) can manage them and the
-- production controller/compositor can read them when starting a broadcast
-- (docs/PRODUCTION_PLATFORM_PLAN.md §3.4-3.5). Written only by the
-- admin-guarded PATCH /api/admin/production/courts/[n]; API responses expose
-- at most a masked last-4 suffix, never the full key.

alter table public.courts
  add column if not exists youtube_stream_key text;

comment on column public.courts.youtube_stream_key is
  'RTMP stream key for the court''s YouTube endpoint, used by the compositor egress (rtmp://a.rtmp.youtube.com/live2/<key>). Admin-managed via /admin/production; never returned to clients unmasked.';
