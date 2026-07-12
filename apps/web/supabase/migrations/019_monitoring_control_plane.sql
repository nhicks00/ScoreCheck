-- 019: Durable low-churn state for the ScoreCheck monitoring control plane.
-- High-frequency numeric samples remain in Prometheus. These tables contain
-- expectations, incident transitions, notification receipts, timed silences,
-- periodic sanitized checkpoints, and calibration/event summaries only.

create table if not exists public.monitoring_profiles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  expected_fps numeric not null default 30 check (expected_fps > 0 and expected_fps <= 120),
  target_bitrate_bps bigint check (target_bitrate_bps is null or target_bitrate_bps > 0),
  expected_width int check (expected_width is null or expected_width > 0),
  expected_height int check (expected_height is null or expected_height > 0),
  expected_video_codec text,
  expected_audio_codec text,
  thresholds jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.court_monitoring_expectations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events(id) on delete cascade,
  court_id uuid not null references public.courts(id) on delete cascade,
  profile_id uuid references public.monitoring_profiles(id) on delete set null,
  coverage_phase text not null default 'OFF'
    check (coverage_phase in ('OFF','WARMUP','LIVE_MATCH','INTERMISSION','FINAL_HOLD','TEARDOWN')),
  media_expectation text not null default 'OFF'
    check (media_expectation in ('OFF','WARM','REQUIRED')),
  broadcast_expectation text not null default 'OFF'
    check (broadcast_expectation in ('OFF','TESTING','LIVE')),
  commentary_expectation text not null default 'NONE'
    check (commentary_expectation in ('NONE','OPTIONAL','REQUIRED')),
  scoring_expectation text not null default 'NONE'
    check (scoring_expectation in ('NONE','SCHEDULED','LIVE','FINAL_HOLD')),
  override_created_by text,
  override_created_at timestamptz,
  override_reason text,
  override_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (event_id, court_id),
  check (
    (override_created_by is null and override_created_at is null and override_reason is null and override_expires_at is null)
    or
    (override_created_by is not null and override_created_at is not null and override_reason is not null and override_expires_at is not null)
  )
);

create table if not exists public.monitoring_incidents (
  id uuid primary key,
  fingerprint text not null unique,
  event_id uuid references public.events(id) on delete set null,
  court_number int check (court_number is null or court_number between 1 and 8),
  host text,
  shared_dependency text,
  stage text not null,
  issue_code text not null,
  severity text not null check (severity in ('info','warning','critical')),
  status text not null check (status in ('open','acknowledged','resolved')),
  confidence text not null default 'high' check (confidence in ('low','medium','high')),
  summary text not null,
  first_action text,
  evidence jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null,
  last_observed_at timestamptz not null,
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists monitoring_incidents_active_idx
  on public.monitoring_incidents(status, severity, opened_at)
  where status <> 'resolved';
create index if not exists monitoring_incidents_event_idx
  on public.monitoring_incidents(event_id, opened_at desc);

create table if not exists public.monitoring_incident_events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.monitoring_incidents(id) on delete cascade,
  event_type text not null check (event_type in (
    'OPENED','SEVERITY_CHANGED','EVIDENCE_UPDATED','ACKNOWLEDGED',
    'SILENCED','ESCALATED','RECOVERING','RESOLVED','REOPENED'
  )),
  actor text,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists monitoring_incident_events_incident_idx
  on public.monitoring_incident_events(incident_id, occurred_at desc);

create table if not exists public.incident_notifications (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references public.monitoring_incidents(id) on delete cascade,
  provider text not null check (provider in ('pushover','twilio_sms','twilio_voice','external')),
  provider_message_id text,
  status text not null check (status in ('pending','accepted','delivered','failed','acknowledged','expired','cancelled')),
  submitted_at timestamptz not null default now(),
  accepted_at timestamptz,
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  expired_at timestamptz,
  escalated_at timestamptz,
  provider_error_code text,
  updated_at timestamptz not null default now()
);

create index if not exists incident_notifications_incident_idx
  on public.incident_notifications(incident_id, submitted_at desc);

create table if not exists public.monitoring_silences (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  court_number int check (court_number is null or court_number between 1 and 8),
  stage text,
  issue_code text,
  reason text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);

create index if not exists monitoring_silences_active_idx
  on public.monitoring_silences(expires_at)
  where revoked_at is null;

create table if not exists public.monitoring_checkpoints (
  scope text primary key,
  event_id uuid references public.events(id) on delete set null,
  payload jsonb not null,
  observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_calibrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  court_id uuid references public.courts(id) on delete cascade,
  method text not null,
  observed_offset_ms numeric,
  result text not null check (result in ('pass','fail','inconclusive')),
  notes text,
  observed_by text not null,
  observed_at timestamptz not null default now()
);

create table if not exists public.event_monitoring_summaries (
  event_id uuid primary key references public.events(id) on delete cascade,
  started_at timestamptz,
  ended_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  generated_at timestamptz not null default now()
);

alter table public.monitoring_profiles enable row level security;
alter table public.court_monitoring_expectations enable row level security;
alter table public.monitoring_incidents enable row level security;
alter table public.monitoring_incident_events enable row level security;
alter table public.incident_notifications enable row level security;
alter table public.monitoring_silences enable row level security;
alter table public.monitoring_checkpoints enable row level security;
alter table public.sync_calibrations enable row level security;
alter table public.event_monitoring_summaries enable row level security;

comment on table public.monitoring_incidents is
  'Durable root incidents emitted on monitoring state transitions; never one row per metric sample.';
comment on table public.monitoring_checkpoints is
  'Periodic sanitized monitor snapshots for stale fallback display when the live monitoring API is unavailable.';
