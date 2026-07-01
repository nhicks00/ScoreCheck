create extension if not exists "pgcrypto";

alter table public.events
  add column if not exists slug text,
  add column if not exists is_active boolean not null default false;

create unique index if not exists events_slug_unique_idx
  on public.events(slug)
  where slug is not null;

create unique index if not exists events_only_one_active_idx
  on public.events(is_active)
  where is_active;

alter table public.courts
  add column if not exists public_score_url text,
  add column if not exists youtube_video_id text,
  add column if not exists youtube_live_chat_id text,
  add column if not exists ivs_channel_arn text,
  add column if not exists ivs_playback_url text,
  add column if not exists scoring_open boolean not null default true,
  add column if not exists backup_requested boolean not null default true;

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  youtube_channel_id text,
  youtube_display_name text,
  youtube_profile_image_url text,
  youtube_verified_at timestamptz,
  is_trusted boolean not null default false,
  is_banned boolean not null default false,
  reputation_score integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists user_profiles_youtube_channel_unique_idx
  on public.user_profiles(youtube_channel_id)
  where youtube_channel_id is not null;

create table if not exists public.scorer_claims (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  verification_code_hash text not null,
  verification_code_label text not null,
  claim_status_token_hash text,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'assigned', 'expired', 'cancelled', 'failed')),
  youtube_live_chat_id text,
  youtube_message_id text,
  youtube_channel_id text,
  youtube_display_name text,
  youtube_profile_image_url text,
  youtube_author_details jsonb not null default '{}'::jsonb,
  requested_role text not null default 'auto'
    check (requested_role in ('auto', 'active', 'backup')),
  assigned_role text
    check (assigned_role in ('active', 'backup', 'waiting')),
  assigned_session_id uuid,
  watch_mode text not null default 'website'
    check (watch_mode in ('website', 'courtside')),
  ip_hash text,
  user_agent text,
  expires_at timestamptz not null,
  verified_at timestamptz,
  assigned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scorer_claims_pending_code_idx
  on public.scorer_claims(status, verification_code_hash, expires_at);

create index if not exists scorer_claims_court_status_idx
  on public.scorer_claims(court_id, status, created_at desc);

create index if not exists scorer_claims_status_token_hash_idx
  on public.scorer_claims(claim_status_token_hash)
  where claim_status_token_hash is not null;

create table if not exists public.scorer_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  claim_id uuid references public.scorer_claims(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  role text not null
    check (role in ('active', 'backup', 'waiting')),
  status text not null default 'active'
    check (status in ('active', 'stale', 'released', 'revoked', 'promoted', 'ended')),
  session_token_hash text not null,
  display_name text not null,
  youtube_channel_id text,
  youtube_display_name text,
  youtube_profile_image_url text,
  device_id_hash text,
  ip_hash text,
  user_agent text,
  priority_score integer not null default 0,
  last_heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  last_action_at timestamptz,
  watch_mode text not null default 'website'
    check (watch_mode in ('website', 'courtside')),
  joined_at timestamptz not null default now(),
  promoted_at timestamptz,
  released_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists scorer_sessions_one_active_per_court_idx
  on public.scorer_sessions(court_id)
  where role = 'active' and status in ('active', 'promoted');

create index if not exists scorer_sessions_court_role_status_idx
  on public.scorer_sessions(court_id, role, status, priority_score desc, joined_at asc);

create index if not exists scorer_sessions_token_hash_idx
  on public.scorer_sessions(session_token_hash);

create unique index if not exists scorer_sessions_claim_unique_idx
  on public.scorer_sessions(claim_id)
  where claim_id is not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'scorer_claims_assigned_session_fk'
  ) then
    alter table public.scorer_claims
      add constraint scorer_claims_assigned_session_fk
      foreign key (assigned_session_id)
      references public.scorer_sessions(id)
      on delete set null;
  end if;
end $$;

create table if not exists public.scorer_shadow_states (
  session_id uuid primary key references public.scorer_sessions(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  team_a_score integer not null default 0,
  team_b_score integer not null default 0,
  team_a_sets integer not null default 0,
  team_b_sets integer not null default 0,
  current_set integer not null default 1,
  set_scores jsonb not null default '[]'::jsonb,
  serving_team text,
  timeouts jsonb not null default '{}'::jsonb,
  status text not null default 'In Progress',
  updated_at timestamptz not null default now()
);

create index if not exists scorer_shadow_states_court_idx
  on public.scorer_shadow_states(court_id, updated_at desc);

create table if not exists public.scorer_session_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  court_id uuid references public.courts(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  session_id uuid references public.scorer_sessions(id) on delete set null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists scorer_session_events_court_idx
  on public.scorer_session_events(court_id, created_at desc);

create index if not exists scorer_session_events_session_idx
  on public.scorer_session_events(session_id, created_at desc);

create table if not exists public.youtube_chat_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  court_id uuid references public.courts(id) on delete set null,
  live_chat_id text not null,
  youtube_message_id text not null,
  message_text text,
  author_channel_id text,
  author_display_name text,
  author_profile_image_url text,
  author_details jsonb not null default '{}'::jsonb,
  matched_claim_id uuid references public.scorer_claims(id) on delete set null,
  published_at timestamptz,
  received_at timestamptz not null default now(),
  unique(live_chat_id, youtube_message_id)
);

create index if not exists youtube_chat_messages_author_idx
  on public.youtube_chat_messages(author_channel_id, received_at desc);

create table if not exists public.court_flags (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  match_id uuid references public.matches(id) on delete set null,
  severity text not null default 'warning'
    check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved')),
  type text not null,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists court_flags_open_idx
  on public.court_flags(event_id, court_id, status, severity);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.overlay_states;
    exception when duplicate_object then null;
    end;

    begin
      alter publication supabase_realtime add table public.score_states;
    exception when duplicate_object then null;
    end;

    begin
      alter publication supabase_realtime add table public.scorer_sessions;
    exception when duplicate_object then null;
    end;

    begin
      alter publication supabase_realtime add table public.court_flags;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
