create extension if not exists "pgcrypto";

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  event_date date,
  venue text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.courts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_number integer not null,
  display_name text not null,
  camera_name text,
  current_match_id uuid,
  mode text not null default 'api' check (mode in ('api', 'manual', 'hybrid')),
  overlay_theme text not null default 'default',
  status text not null default 'idle',
  frozen boolean not null default false,
  last_update_at timestamptz,
  scorer_token text not null default encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(event_id, court_number)
);

create table if not exists public.bracket_sources (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  source_url text not null,
  source_type text not null default 'unknown',
  status text not null default 'pending',
  last_error text,
  discovered_at timestamptz,
  created_at timestamptz not null default now(),
  unique(event_id, source_url)
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  external_match_id text,
  api_url text not null,
  bracket_url text,
  match_number text,
  round_name text,
  scheduled_time text,
  scheduled_date text,
  court_number text,
  physical_court text,
  team_a text,
  team_b text,
  team_a_seed text,
  team_b_seed text,
  team_a_players jsonb not null default '[]'::jsonb,
  team_b_players jsonb not null default '[]'::jsonb,
  format jsonb not null default '{}'::jsonb,
  status text not null default 'scheduled',
  winner text,
  source_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(event_id, api_url)
);

alter table public.courts
  add constraint courts_current_match_fk
  foreign key (current_match_id)
  references public.matches(id)
  on delete set null;

create table if not exists public.score_states (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references public.matches(id) on delete cascade,
  court_id uuid references public.courts(id) on delete cascade,
  team_a_score integer not null default 0,
  team_b_score integer not null default 0,
  team_a_sets integer not null default 0,
  team_b_sets integer not null default 0,
  current_set integer not null default 1,
  set_scores jsonb not null default '[]'::jsonb,
  serving_team text,
  timeouts jsonb not null default '{}'::jsonb,
  status text not null default 'prematch',
  source text not null default 'api' check (source in ('api', 'manual', 'override')),
  stale boolean not null default false,
  message text,
  last_api_poll_at timestamptz,
  last_score_change_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(court_id)
);

create table if not exists public.overlay_states (
  court_id uuid primary key references public.courts(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  court_number integer not null,
  payload jsonb not null,
  stale boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists public.score_actions (
  id uuid primary key default gen_random_uuid(),
  court_id uuid references public.courts(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  actor text not null default 'system',
  created_at timestamptz not null default now()
);

create table if not exists public.poller_leases (
  court_id uuid primary key references public.courts(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  owner text not null,
  expires_at timestamptz not null,
  last_heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  court_id uuid references public.courts(id) on delete set null,
  actor text not null default 'admin',
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists matches_event_idx on public.matches(event_id);
create index if not exists courts_event_idx on public.courts(event_id);
create index if not exists score_states_court_idx on public.score_states(court_id);
create index if not exists overlay_states_event_idx on public.overlay_states(event_id);
