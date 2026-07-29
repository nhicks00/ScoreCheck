-- 032: Program continuity is owned by the conservative HLS buffer. The
-- admitted raw/normalized source now reaches the HLS remux over loopback
-- RTSP/TCP, so there is no separate SRT source delay to add to score timing.

alter table public.courts
  alter column program_video_delay_ms set default 0;

update public.courts
set program_video_delay_ms = 0
where program_video_delay_ms <> 0;

comment on column public.courts.program_video_delay_ms is
  'Additional source delay before measured HLS playout. Direct RTSP/TCP program transport uses 0 ms.';
