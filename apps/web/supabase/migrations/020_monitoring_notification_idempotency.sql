-- 020: Make notification dispatch restart-safe and idempotent per incident,
-- provider, and purpose. Provider receipts remain low-churn durable state.

alter table public.incident_notifications
  add column if not exists notification_kind text not null default 'open'
    check (notification_kind in ('open','recovery','escalation','test'));

create unique index if not exists incident_notifications_dispatch_key
  on public.incident_notifications(incident_id, provider, notification_kind);
