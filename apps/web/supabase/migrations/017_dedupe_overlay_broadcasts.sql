-- 017: Prevent timestamp-only overlay refreshes from filling Realtime's
-- retained broadcast partitions. Overlay clients already poll state every two
-- seconds, while broadcasts are the low-latency path for semantic changes.

create or replace function public.broadcast_overlay_state_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, realtime
as $$
declare
  new_semantic_payload jsonb;
  old_semantic_payload jsonb;
begin
  new_semantic_payload := NEW.payload
    #- '{health,lastUpdateAt}'
    #- '{health,lastApiPollAt}';

  if TG_OP = 'UPDATE' then
    old_semantic_payload := OLD.payload
      #- '{health,lastUpdateAt}'
      #- '{health,lastApiPollAt}';

    if new_semantic_payload is not distinct from old_semantic_payload
      and NEW.stale is not distinct from OLD.stale
      and NEW.event_id is not distinct from OLD.event_id
      and NEW.court_number is not distinct from OLD.court_number then
      return NEW;
    end if;
  end if;

  perform realtime.send(
    NEW.payload,
    'overlay_state',
    'overlay:' || NEW.event_id::text || ':court:' || NEW.court_number::text,
    false
  );
  return NEW;
end;
$$;

comment on function public.broadcast_overlay_state_change() is
  'Broadcasts semantic overlay changes while suppressing poll-timestamp-only duplicates.';

-- Overlay clients subscribe to the explicit broadcast above, not Postgres
-- Changes for overlay_states. Removing the unused publication entry avoids
-- decoding every high-frequency health timestamp update a second time.
do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'overlay_states'
  ) then
    alter publication supabase_realtime drop table public.overlay_states;
  end if;
end $$;
