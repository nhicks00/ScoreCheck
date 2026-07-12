-- 015: Hard cutover from one ambiguous court stream path to separate
-- low-latency preview and controlled-delay program paths.

alter table public.courts
  rename column stream_path to preview_stream_path;

alter table public.courts
  add column program_stream_path text,
  add column program_video_delay_ms integer not null default 3500
    check (program_video_delay_ms between 0 and 30000),
  add column camera_audio_gain_db numeric not null default 0
    check (camera_audio_gain_db between -60 and 12),
  add column commentary_gain_db numeric not null default 0
    check (commentary_gain_db between -60 and 12),
  add column commentary_delay_ms integer not null default 0
    check (commentary_delay_ms between 0 and 10000);

update public.courts
set
  preview_stream_path = 'court' || court_number || '_preview',
  program_stream_path = coalesce(nullif(btrim(program_stream_path), ''), 'court' || court_number || '_program');

alter table public.courts
  alter column preview_stream_path set not null,
  alter column program_stream_path set not null;

comment on column public.courts.preview_stream_path is
  'Undelayed normalized MediaMTX path used by commentators, scorers, and producer previews.';
comment on column public.courts.program_stream_path is
  'Controlled-delay clean MediaMTX path consumed only by the compositor program scene.';
comment on column public.courts.program_video_delay_ms is
  'Target coarse video delay for the program path. MediaMTX/controller reconciles the actual delayed path.';
comment on column public.courts.camera_audio_gain_db is
  'Camera/ambient audio gain applied by the program scene Web Audio graph.';
comment on column public.courts.commentary_gain_db is
  'Commentary audio gain applied by the program scene Web Audio graph.';
comment on column public.courts.commentary_delay_ms is
  'Fine commentary delay applied after coarse program-video delay.';

alter table public.program_heartbeats
  rename column commentary_loaded to commentary_room_connected;

alter table public.program_heartbeats
  add column commentary_participant_count integer,
  add column commentary_audio_track_count integer,
  add column commentary_rms_db numeric,
  add column commentary_peak_db numeric,
  add column seconds_since_commentary_audio numeric,
  add column camera_audio_rms_db numeric;

comment on column public.program_heartbeats.commentary_room_connected is
  'True only when the program scene is connected to its self-hosted LiveKit court room.';
comment on column public.program_heartbeats.commentary_audio_track_count is
  'Number of subscribed remote commentary audio tracks in the program mixer.';
comment on column public.program_heartbeats.seconds_since_commentary_audio is
  'Seconds since commentary crossed the non-silence threshold; null when never heard.';
