-- 018: The poller and bracket refresher can alternate the diagnostic health
-- message while every rendered and actionable overlay field remains stable.
-- Keep that nonvisual churn out of retained Realtime broadcasts.

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
    #- '{health,lastApiPollAt}'
    #- '{health,message}';

  if TG_OP = 'UPDATE' then
    old_semantic_payload := OLD.payload
      #- '{health,lastUpdateAt}'
      #- '{health,lastApiPollAt}'
      #- '{health,message}';

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
  'Broadcasts rendered or actionable overlay changes while suppressing polling and diagnostic churn.';
