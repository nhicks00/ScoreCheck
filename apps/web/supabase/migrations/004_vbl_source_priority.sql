alter table public.courts
  add column if not exists vbl_court_number text,
  add column if not exists vbl_court_label text;

create index if not exists courts_event_vbl_court_number_idx
  on public.courts(event_id, vbl_court_number)
  where vbl_court_number is not null;

alter table public.score_states
  add column if not exists source_available boolean not null default false,
  add column if not exists source_priority text not null default 'fallback'
    check (source_priority in ('primary', 'fallback', 'override'));
