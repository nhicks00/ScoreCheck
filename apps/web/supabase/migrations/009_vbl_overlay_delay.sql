alter table public.score_states
  add column if not exists source_pending_scores jsonb not null default '[]'::jsonb;
