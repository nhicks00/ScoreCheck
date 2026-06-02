alter table public.events
  add column if not exists settings jsonb not null default '{
    "defaultFormat": {
      "bestOf": 3,
      "pointsPerSet": [21, 21, 15],
      "winByTwo": true,
      "cap": null,
      "setsToWin": 2
    },
    "staleTimeoutSeconds": 20,
    "activePollIntervalMs": 1800,
    "upcomingPollIntervalMs": 20000,
    "overlayTheme": "default"
  }'::jsonb;

alter table public.matches
  add column if not exists source_type text not null default 'vbl'
    check (source_type in ('vbl', 'manual'));

alter table public.matches
  alter column api_url drop not null;

alter table public.courts
  add column if not exists scorer_token_hash text,
  add column if not exists scorer_token_created_at timestamptz,
  add column if not exists scorer_token_rotated_at timestamptz,
  add column if not exists scorer_token_revoked_at timestamptz;

alter table public.courts
  drop column if exists scorer_token;

create table if not exists public.court_match_queue (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid not null references public.matches(id) on delete cascade,
  queue_position integer not null,
  is_active boolean not null default false,
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(court_id, queue_position)
);

create unique index if not exists court_match_queue_one_active_idx
  on public.court_match_queue(court_id)
  where is_active;

insert into public.court_match_queue (event_id, court_id, match_id, queue_position, is_active, status)
select c.event_id, c.id, c.current_match_id, 1, true, 'active'
from public.courts c
where c.current_match_id is not null
  and not exists (
    select 1
    from public.court_match_queue q
    where q.court_id = c.id
      and q.match_id = c.current_match_id
  );

alter table public.score_actions
  add column if not exists action_id text,
  add column if not exists previous_state jsonb,
  add column if not exists next_state jsonb,
  add column if not exists actor_type text not null default 'admin'
    check (actor_type in ('admin', 'scorer', 'worker')),
  add column if not exists actor_label text,
  add column if not exists ip_hash text,
  add column if not exists user_agent text;

create unique index if not exists score_actions_action_id_idx
  on public.score_actions(action_id)
  where action_id is not null;

create table if not exists public.worker_heartbeats (
  worker_id text primary key,
  status text not null default 'starting',
  event_id uuid references public.events(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.poller_jobs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid references public.courts(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  status text not null default 'active',
  owner text,
  last_polled_at timestamptz,
  next_poll_at timestamptz,
  error_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.poller_errors (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  court_id uuid references public.courts(id) on delete set null,
  match_id uuid references public.matches(id) on delete set null,
  source_url text,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists court_match_queue_court_idx on public.court_match_queue(court_id, queue_position);
create index if not exists worker_heartbeats_last_seen_idx on public.worker_heartbeats(last_seen_at);
create index if not exists poller_jobs_next_poll_idx on public.poller_jobs(status, next_poll_at);
create index if not exists poller_errors_event_idx on public.poller_errors(event_id, created_at desc);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.overlay_states;
    exception
      when duplicate_object then null;
    end;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'realtime') then
    execute $function$
      create or replace function public.broadcast_overlay_state_change()
      returns trigger
      language plpgsql
      security definer
      as $body$
      begin
        perform realtime.send(
          NEW.payload,
          'overlay_state',
          'overlay:' || NEW.event_id::text || ':court:' || NEW.court_number::text,
          false
        );
        return NEW;
      end;
      $body$;
    $function$;

    drop trigger if exists broadcast_overlay_state_change_trigger on public.overlay_states;
    create trigger broadcast_overlay_state_change_trigger
      after insert or update on public.overlay_states
      for each row execute function public.broadcast_overlay_state_change();
  end if;
exception
  when undefined_function then
    null;
end $$;
