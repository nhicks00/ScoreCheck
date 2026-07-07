-- MediaMTX stream paths replace the Amazon IVS metadata on courts.
-- courts.ivs_channel_arn and courts.ivs_playback_url are deprecated and no
-- longer read by the app; they are intentionally kept (non-destructive) in
-- case a rollback to the IVS video layer is ever needed.

alter table public.courts
  add column if not exists stream_path text;

comment on column public.courts.stream_path is
  'MediaMTX stream path for this court. When null the app falls back to COURT_{N}_STREAM_PATH env or the default court{n}.';

comment on column public.courts.ivs_channel_arn is
  'Deprecated: unused since the MediaMTX video layer replaced Amazon IVS. Kept for rollback only.';

comment on column public.courts.ivs_playback_url is
  'Deprecated: unused since the MediaMTX video layer replaced Amazon IVS. Kept for rollback only.';
