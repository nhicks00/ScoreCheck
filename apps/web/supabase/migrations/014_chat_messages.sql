-- 014: Unified live-chat monitor store.
-- The broadcast operator watches YouTube live-chat from all court streams in
-- one place (/chat). The Render worker's quota-throttled reader (lib/chatPoller
-- via lib/youtubeChat) pulls messages from the official YouTube Data API v3 and
-- upserts them here, tagged with the court they came from so an operator can
-- see "fix court 3's camera" and know which stream. Distinct from migration
-- 003's youtube_chat_messages, which backs the scorer-claim verification flow.
-- Service-role only (no RLS), matching every other table in this project; the
-- /chat surface reads through admin-guarded server code + a passcode gate.

create extension if not exists "pgcrypto";

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  court_id uuid references public.courts(id) on delete cascade,
  court_number int,
  court_label text,
  youtube_message_id text unique not null,
  author_name text,
  author_channel_id text,
  is_moderator boolean default false,
  is_owner boolean default false,
  message_text text,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.chat_messages is
  'Unified YouTube live-chat feed for the broadcast operator (/chat). One row per '
  'chat message across all court streams of the active event, tagged with the '
  'originating court (court_number/court_label) so messages can be filtered and '
  'colour-coded per stream. Written only by the quota-throttled worker reader '
  '(lib/chatPoller); youtube_message_id is the unique dedup key so an on-conflict '
  'do-nothing upsert makes re-polling idempotent.';

-- Feed queries: newest-first within an event, and per-court within a court.
create index if not exists chat_messages_event_published_idx
  on public.chat_messages(event_id, published_at desc);

create index if not exists chat_messages_court_published_idx
  on public.chat_messages(court_number, published_at desc);

-- Realtime INSERTs power the live feed (client subscribes filtered by event_id).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.chat_messages;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
