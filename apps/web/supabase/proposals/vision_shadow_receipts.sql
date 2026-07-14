-- 017: Authenticated, append-only vision receipt storage.
--
-- There is deliberately no database projection, scoring-readiness state, score
-- bridge, or directly selectable consumer table. Ed25519 verification occurs in the Node
-- adapter before the fixed write RPC. The fixed read RPC returns typed evidence
-- to Node, where every envelope is authenticated again before projection.
--
-- The vision_shadow_ingest role is therefore a trusted adapter principal and
-- must never be held by the dispatcher. Whole-history rollback detection still
-- requires an externally protected monotonic ScoreCheck receipt checkpoint;
-- that checkpoint is not implemented by this migration.

create extension if not exists "pgcrypto";

-- Normalize fixed NOLOGIN capability roles even when a prior failed deployment
-- left one behind. Membership *in* another role is removed; deployment may
-- separately grant these capabilities to its narrowly authenticated principals.
do $$
declare
  v_capability text;
  v_parent text;
  v_member text;
begin
  foreach v_capability in array array[
    'vision_shadow_ingest',
    'vision_shadow_binding_publisher',
    'vision_shadow_reader'
  ] loop
    if not exists (select 1 from pg_roles where rolname = v_capability) then
      execute format('create role %I nologin', v_capability);
    end if;
    execute format(
      'alter role %I with nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit',
      v_capability
    );
    execute format(
      'revoke all privileges on database %I from %I',
      current_database(),
      v_capability
    );
    for v_parent in
      select parent.rolname
      from pg_auth_members membership
      join pg_roles member on member.oid = membership.member
      join pg_roles parent on parent.oid = membership.roleid
      where member.rolname = v_capability
    loop
      execute format('revoke %I from %I', v_parent, v_capability);
    end loop;
    for v_member in
      select member.rolname
      from pg_auth_members membership
      join pg_roles member on member.oid = membership.member
      join pg_roles capability on capability.oid = membership.roleid
      where capability.rolname = v_capability
    loop
      execute format('revoke %I from %I', v_capability, v_member);
    end loop;
  end loop;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_class object
    join pg_roles owner on owner.oid = object.relowner
    where owner.rolname in (
      'vision_shadow_ingest',
      'vision_shadow_binding_publisher',
      'vision_shadow_reader'
    )
  ) or exists (
    select 1
    from pg_proc object
    join pg_roles owner on owner.oid = object.proowner
    where owner.rolname in (
      'vision_shadow_ingest',
      'vision_shadow_binding_publisher',
      'vision_shadow_reader'
    )
  ) or exists (
    select 1
    from pg_namespace object
    join pg_roles owner on owner.oid = object.nspowner
    where owner.rolname in (
      'vision_shadow_ingest',
      'vision_shadow_binding_publisher',
      'vision_shadow_reader'
    )
  ) or exists (
    select 1
    from pg_type object
    join pg_roles owner on owner.oid = object.typowner
    where owner.rolname in (
      'vision_shadow_ingest',
      'vision_shadow_binding_publisher',
      'vision_shadow_reader'
    )
  ) or exists (
    select 1
    from pg_database object
    join pg_roles owner on owner.oid = object.datdba
    where owner.rolname in (
      'vision_shadow_ingest',
      'vision_shadow_binding_publisher',
      'vision_shadow_reader'
    )
  ) or exists (
    select 1
    from pg_tablespace object
    join pg_roles owner on owner.oid = object.spcowner
    where owner.rolname in (
      'vision_shadow_ingest',
      'vision_shadow_binding_publisher',
      'vision_shadow_reader'
    )
  ) then
    raise exception 'vision capability role owns database objects; remove ownership before hard cutover'
      using errcode = '55000';
  end if;
end
$$;

-- Remove stale direct privileges from any partial prior deployment before
-- creating this slice. Exact function authority is granted only at the end.
revoke all privileges on all tables in schema public
  from vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all privileges on all sequences in schema public
  from vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all privileges on all functions in schema public
  from vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke create on schema public
  from vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
grant usage on schema public
  to vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;

create table public.vision_match_bindings (
  source_ledger_id text not null
    check (source_ledger_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  source_match_id text not null
    check (source_match_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  -- Historical target UUIDs intentionally have no parent foreign keys. Parent
  -- deletion or reassignment cannot cascade into immutable vision history.
  scorecheck_event_id uuid not null,
  scorecheck_court_id uuid not null,
  scorecheck_match_id uuid not null,
  active_from_ns bigint not null check (active_from_ns >= 0),
  protected_configuration_sha256 text not null
    check (protected_configuration_sha256 ~ '^[0-9a-f]{64}$'),
  published_at_ns bigint not null
    check (published_at_ns >= 0 and published_at_ns <= active_from_ns),
  primary key (source_ledger_id, source_match_id),
  unique (
    source_ledger_id,
    source_match_id,
    scorecheck_event_id,
    scorecheck_court_id,
    scorecheck_match_id
  )
);

create table public.vision_shadow_receipts (
  source_ledger_id text not null
    check (source_ledger_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  outbox_id bigint not null check (outbox_id between 1 and 9223372036854775807),
  message_id text not null check (message_id ~ '^[!-~]{1,192}$'),
  source_match_id text not null
    check (source_match_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  source_revision bigint not null check (source_revision between 1 and 4096),
  source_event_id text not null check (source_event_id ~ '^[!-~]{1,128}$'),
  source_payload_bytes bytea not null
    check (octet_length(source_payload_bytes) between 1 and 16384),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  transport_envelope_bytes bytea not null
    check (octet_length(transport_envelope_bytes) between 1 and 32768),
  transport_envelope_sha256 text not null
    check (transport_envelope_sha256 ~ '^[0-9a-f]{64}$'),
  dispatcher_id text not null
    check (dispatcher_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  dispatcher_key_id text not null
    check (dispatcher_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  dispatch_attempt_id text not null
    check (dispatch_attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  dispatch_signed_at_ns bigint not null check (dispatch_signed_at_ns >= 0),
  dispatch_expires_at_ns bigint not null
    check (dispatch_expires_at_ns >= dispatch_signed_at_ns),
  received_at_ns bigint not null check (received_at_ns >= 0),
  appended_at_ns bigint not null check (appended_at_ns >= 0),
  event_type text not null check (
    event_type in (
      'SET_SEED',
      'POINT_AWARDED',
      'REPLAY_NO_POINT',
      'SIDE_SWITCH_CONFIRMED',
      'TECHNICAL_TIMEOUT_COMPLETED'
    )
  ),
  event_summary jsonb not null check (jsonb_typeof(event_summary) = 'object'),
  post_state_summary jsonb not null check (jsonb_typeof(post_state_summary) = 'object'),
  ruleset_id text not null check (ruleset_id ~ '^[!-~]{1,128}$'),
  ruleset_version text not null check (ruleset_version ~ '^[!-~]{1,128}$'),
  ruleset_fingerprint text not null check (ruleset_fingerprint ~ '^[0-9a-f]{64}$'),
  reducer_build_sha256 text not null check (reducer_build_sha256 ~ '^[0-9a-f]{64}$'),
  adopted_archive_fingerprint text not null
    check (adopted_archive_fingerprint ~ '^[0-9a-f]{64}$'),
  authorization_record_fingerprint text not null
    check (authorization_record_fingerprint ~ '^[0-9a-f]{64}$'),
  source_envelope_fingerprint text not null
    check (source_envelope_fingerprint ~ '^[0-9a-f]{64}$'),
  event_fingerprint text not null check (event_fingerprint ~ '^[0-9a-f]{64}$'),
  state_fingerprint text not null check (state_fingerprint ~ '^[0-9a-f]{64}$'),
  review_history_head_sha256 text not null
    check (review_history_head_sha256 ~ '^[0-9a-f]{64}$'),
  review_position bigint not null check (review_position between 0 and 3072),
  scorer_copilot_case_fingerprint text
    check (
      scorer_copilot_case_fingerprint is null or
      scorer_copilot_case_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  scorer_copilot_signed_case_fingerprint text
    check (
      scorer_copilot_signed_case_fingerprint is null or
      scorer_copilot_signed_case_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  scorer_copilot_case_link_fingerprint text
    check (
      scorer_copilot_case_link_fingerprint is null or
      scorer_copilot_case_link_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  review_authorization_context_fingerprint text
    check (
      review_authorization_context_fingerprint is null or
      review_authorization_context_fingerprint ~ '^[0-9a-f]{64}$'
    ),
  binding_generation smallint not null default 1 check (binding_generation = 1),
  scorecheck_event_id uuid not null,
  scorecheck_court_id uuid not null,
  scorecheck_match_id uuid not null,
  primary key (source_ledger_id, outbox_id),
  unique (source_ledger_id, message_id),
  unique (source_ledger_id, source_match_id, source_revision),
  unique (source_ledger_id, source_match_id, source_event_id),
  check (
    (
      scorer_copilot_case_fingerprint is null and
      scorer_copilot_signed_case_fingerprint is null and
      scorer_copilot_case_link_fingerprint is null and
      review_authorization_context_fingerprint is null
    ) or (
      scorer_copilot_case_fingerprint is not null and
      scorer_copilot_signed_case_fingerprint is not null and
      scorer_copilot_case_link_fingerprint is not null and
      review_authorization_context_fingerprint is not null
    )
  ),
  foreign key (
    source_ledger_id,
    source_match_id,
    scorecheck_event_id,
    scorecheck_court_id,
    scorecheck_match_id
  ) references public.vision_match_bindings(
    source_ledger_id,
    source_match_id,
    scorecheck_event_id,
    scorecheck_court_id,
    scorecheck_match_id
  ) on delete restrict
);

create table public.vision_shadow_integrity_blocks (
  source_ledger_id text primary key
    check (source_ledger_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  block_code text not null check (
    block_code in (
      'IDENTITY_CONFLICT',
      'SOURCE_IDENTITY_CONFLICT',
      'SOURCE_LINEAGE_CONFLICT'
    )
  ),
  observed_outbox_id bigint not null check (observed_outbox_id >= 1),
  observed_message_id text not null check (observed_message_id ~ '^[!-~]{1,192}$'),
  observed_payload_sha256 text not null check (observed_payload_sha256 ~ '^[0-9a-f]{64}$'),
  existing_payload_sha256 text
    check (
      existing_payload_sha256 is null or
      existing_payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
  blocked_at_ns bigint not null check (blocked_at_ns >= 0)
);

create index vision_shadow_receipts_replay_idx
  on public.vision_shadow_receipts(source_ledger_id, source_match_id, source_revision);

-- No policies and no direct grants: capability roles can use only fixed
-- SECURITY DEFINER functions. RLS remains a second barrier against accidental
-- future grants, while the table-owning fixed functions retain access.
alter table public.vision_match_bindings enable row level security;
alter table public.vision_shadow_receipts enable row level security;
alter table public.vision_shadow_integrity_blocks enable row level security;

create or replace function public.vision_reject_immutable_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'vision immutable history cannot be updated or deleted'
    using errcode = '55000';
end;
$$;

create trigger vision_match_bindings_immutable
  before update or delete on public.vision_match_bindings
  for each row execute function public.vision_reject_immutable_mutation();
create trigger vision_shadow_receipts_append_only
  before update or delete on public.vision_shadow_receipts
  for each row execute function public.vision_reject_immutable_mutation();
create trigger vision_shadow_integrity_blocks_immutable
  before update or delete on public.vision_shadow_integrity_blocks
  for each row execute function public.vision_reject_immutable_mutation();

create or replace function public.vision_binding_lock_key(
  p_source_ledger_id text,
  p_source_match_id text
)
returns bigint
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select hashtextextended(p_source_ledger_id || chr(31) || p_source_match_id, 917642319)
$$;

create or replace function public.vision_ledger_lock_key(p_source_ledger_id text)
returns bigint
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select hashtextextended(p_source_ledger_id, 917642320)
$$;

create or replace function public.vision_publish_match_binding(
  p_source_ledger_id text,
  p_source_match_id text,
  p_scorecheck_event_id uuid,
  p_scorecheck_court_id uuid,
  p_scorecheck_match_id uuid,
  p_active_from_ns bigint,
  p_protected_configuration_sha256 text,
  p_published_at_ns bigint
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_source_ledger_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$' or
     p_source_match_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$' or
     p_protected_configuration_sha256 !~ '^[0-9a-f]{64}$' or
     p_active_from_ns < 0 or
     p_published_at_ns < 0 or
     p_published_at_ns > p_active_from_ns then
    raise exception 'invalid immutable vision binding' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(
    public.vision_binding_lock_key(p_source_ledger_id, p_source_match_id)
  );
  if exists (
    select 1 from public.vision_match_bindings
    where source_ledger_id = p_source_ledger_id
      and source_match_id = p_source_match_id
  ) then
    raise exception 'vision binding is immutable; publish a new source_match_id'
      using errcode = '23505';
  end if;

  perform 1
  from public.courts c
  join public.matches m on m.id = p_scorecheck_match_id
  where c.id = p_scorecheck_court_id
    and c.event_id = p_scorecheck_event_id
    and c.current_match_id = p_scorecheck_match_id
    and m.event_id = p_scorecheck_event_id
  for share of c;
  if not found then
    raise exception 'vision binding does not match the protected current court assignment'
      using errcode = '23514';
  end if;

  insert into public.vision_match_bindings(
    source_ledger_id,
    source_match_id,
    scorecheck_event_id,
    scorecheck_court_id,
    scorecheck_match_id,
    active_from_ns,
    protected_configuration_sha256,
    published_at_ns
  ) values (
    p_source_ledger_id,
    p_source_match_id,
    p_scorecheck_event_id,
    p_scorecheck_court_id,
    p_scorecheck_match_id,
    p_active_from_ns,
    p_protected_configuration_sha256,
    p_published_at_ns
  );
end;
$$;

create or replace function public.vision_accept_shadow_receipt(
  p_transport_envelope_bytes bytea,
  p_source_payload_bytes bytea,
  p_received_at_ns bigint
)
returns table(result_code text, result_detail text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_envelope jsonb;
  v_payload jsonb;
  v_payload_fields text[];
  v_envelope_fields text[];
  v_source_ledger_id text;
  v_source_match_id text;
  v_outbox_id bigint;
  v_message_id text;
  v_source_revision bigint;
  v_source_event_id text;
  v_appended_at_ns bigint;
  v_payload_sha256 text;
  v_transport_sha256 text;
  v_identity_count integer;
  v_existing public.vision_shadow_receipts%rowtype;
  v_binding public.vision_match_bindings%rowtype;
begin
  if p_received_at_ns < 0 then
    raise exception 'protected receipt time is invalid' using errcode = '23514';
  end if;
  if octet_length(p_transport_envelope_bytes) not between 1 and 32768 or
     octet_length(p_source_payload_bytes) not between 1 and 16384 then
    raise exception 'vision transport bytes exceed fixed bounds' using errcode = '22001';
  end if;

  v_envelope := convert_from(p_transport_envelope_bytes, 'UTF8')::jsonb;
  v_payload := convert_from(p_source_payload_bytes, 'UTF8')::jsonb;
  if jsonb_typeof(v_envelope) is distinct from 'object' or
     jsonb_typeof(v_payload) is distinct from 'object' then
    raise exception 'vision transport values must be objects' using errcode = '22023';
  end if;

  v_source_ledger_id := v_envelope ->> 'source_ledger_id';
  v_source_match_id := v_payload ->> 'match_id';
  v_outbox_id := (v_payload ->> 'outbox_id')::bigint;
  v_message_id := v_payload ->> 'message_id';
  v_source_revision := (v_payload ->> 'revision')::bigint;
  v_source_event_id := v_payload ->> 'event_id';
  v_appended_at_ns := (v_payload ->> 'appended_at_ns')::bigint;
  v_payload_sha256 := encode(digest(p_source_payload_bytes, 'sha256'), 'hex');
  v_transport_sha256 := encode(digest(p_transport_envelope_bytes, 'sha256'), 'hex');

  select array_agg(field order by field) into v_payload_fields
  from jsonb_object_keys(v_payload) as fields(field);
  select array_agg(field order by field) into v_envelope_fields
  from jsonb_object_keys(v_envelope) as fields(field);

  if v_payload_fields is distinct from array[
       'adopted_archive_fingerprint',
       'appended_at_ns',
       'authorization_record_fingerprint',
       'envelope_fingerprint',
       'event_fingerprint',
       'event_id',
       'event_summary',
       'match_id',
       'message_id',
       'official_scorecheck_mutation_permitted',
       'outbox_id',
       'post_state_summary',
       'reducer_build_sha256',
       'review_authorization_context_fingerprint',
       'review_history_head_sha256',
       'review_position',
       'revision',
       'ruleset_fingerprint',
       'ruleset_id',
       'ruleset_version',
       'schema_version',
       'scorer_copilot_case_fingerprint',
       'scorer_copilot_case_link_fingerprint',
       'scorer_copilot_signed_case_fingerprint',
       'state_fingerprint',
       'target',
       'topic'
     ]::text[] or
     v_envelope_fields is distinct from array[
       'algorithm',
       'attempt_id',
       'dispatcher_id',
       'dispatcher_key_id',
       'expires_at_ns',
       'message_id',
       'outbox_id',
       'payload_base64',
       'payload_sha256',
       'schema_version',
       'signature_base64',
       'signed_at_ns',
       'source_ledger_id'
     ]::text[] or
     (v_payload ->> 'schema_version') is distinct from '2.0' or
     (v_payload ->> 'topic') is distinct from 'vision_scoring.shadow.authorized_event.v2' or
     (v_payload ->> 'target') is distinct from 'SHADOW_ONLY_NO_OFFICIAL_SCORECHECK_MUTATION' or
     (v_payload -> 'official_scorecheck_mutation_permitted') is distinct from 'false'::jsonb or
     v_message_id is distinct from 'shadow:' || v_outbox_id::text || ':' || v_source_event_id or
     (v_envelope ->> 'schema_version') is distinct from '1.0' or
     (v_envelope ->> 'algorithm') is distinct from 'Ed25519' or
     (v_envelope ->> 'outbox_id')::bigint is distinct from v_outbox_id or
     (v_envelope ->> 'message_id') is distinct from v_message_id or
     (v_envelope ->> 'payload_sha256') is distinct from v_payload_sha256 or
     (v_envelope ->> 'payload_base64') is distinct from
       replace(encode(p_source_payload_bytes, 'base64'), E'\n', '') then
    raise exception 'vision envelope and payload identities do not match the frozen contract'
      using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(public.vision_ledger_lock_key(v_source_ledger_id));
  perform pg_advisory_xact_lock(
    public.vision_binding_lock_key(v_source_ledger_id, v_source_match_id)
  );

  if exists (
    select 1 from public.vision_shadow_integrity_blocks
    where source_ledger_id = v_source_ledger_id
  ) then
    return query select 'SOURCE_BLOCKED'::text, 'TERMINAL_INTEGRITY_BLOCK'::text;
    return;
  end if;

  select count(*) into v_identity_count
  from public.vision_shadow_receipts
  where source_ledger_id = v_source_ledger_id
    and (outbox_id = v_outbox_id or message_id = v_message_id);

  if v_identity_count = 1 then
    select * into v_existing
    from public.vision_shadow_receipts
    where source_ledger_id = v_source_ledger_id
      and (outbox_id = v_outbox_id or message_id = v_message_id)
    limit 1;
    if v_existing.outbox_id = v_outbox_id and
       v_existing.message_id = v_message_id and
       v_existing.payload_sha256 = v_payload_sha256 and
       v_existing.source_payload_bytes = p_source_payload_bytes then
      return query select 'EXACT_RETRY'::text, null::text;
      return;
    end if;
  end if;

  if v_identity_count > 0 then
    insert into public.vision_shadow_integrity_blocks(
      source_ledger_id,
      block_code,
      observed_outbox_id,
      observed_message_id,
      observed_payload_sha256,
      existing_payload_sha256,
      blocked_at_ns
    ) values (
      v_source_ledger_id,
      'IDENTITY_CONFLICT',
      v_outbox_id,
      v_message_id,
      v_payload_sha256,
      v_existing.payload_sha256,
      p_received_at_ns
    );
    return query select 'INTEGRITY_BLOCKED'::text, 'IDENTITY_CONFLICT'::text;
    return;
  end if;

  select * into v_existing
  from public.vision_shadow_receipts
  where source_ledger_id = v_source_ledger_id
    and source_match_id = v_source_match_id
    and (source_revision = v_source_revision or source_event_id = v_source_event_id)
  limit 1;
  if found then
    insert into public.vision_shadow_integrity_blocks(
      source_ledger_id,
      block_code,
      observed_outbox_id,
      observed_message_id,
      observed_payload_sha256,
      existing_payload_sha256,
      blocked_at_ns
    ) values (
      v_source_ledger_id,
      'SOURCE_IDENTITY_CONFLICT',
      v_outbox_id,
      v_message_id,
      v_payload_sha256,
      v_existing.payload_sha256,
      p_received_at_ns
    );
    return query select 'INTEGRITY_BLOCKED'::text, 'SOURCE_IDENTITY_CONFLICT'::text;
    return;
  end if;

  select * into v_binding
  from public.vision_match_bindings
  where source_ledger_id = v_source_ledger_id
    and source_match_id = v_source_match_id;
  if not found then
    return query select 'BINDING_REJECTED'::text, 'MISSING_BINDING'::text;
    return;
  end if;
  if v_appended_at_ns < v_binding.active_from_ns then
    return query select 'BINDING_REJECTED'::text, 'STALE_BINDING'::text;
    return;
  end if;

  perform 1
  from public.courts c
  join public.matches m on m.id = v_binding.scorecheck_match_id
  where c.id = v_binding.scorecheck_court_id
    and c.event_id = v_binding.scorecheck_event_id
    and c.current_match_id = v_binding.scorecheck_match_id
    and m.event_id = v_binding.scorecheck_event_id
  for share of c;
  if not found then
    return query select 'BINDING_REJECTED'::text, 'REASSIGNED_BINDING'::text;
    return;
  end if;

  select * into v_existing
  from public.vision_shadow_receipts
  where source_ledger_id = v_source_ledger_id
    and source_match_id = v_source_match_id
    and (
      reducer_build_sha256 is distinct from (v_payload ->> 'reducer_build_sha256') or
      ruleset_id is distinct from (v_payload ->> 'ruleset_id') or
      ruleset_version is distinct from (v_payload ->> 'ruleset_version') or
      ruleset_fingerprint is distinct from (v_payload ->> 'ruleset_fingerprint')
    )
  limit 1;
  if found then
    insert into public.vision_shadow_integrity_blocks(
      source_ledger_id,
      block_code,
      observed_outbox_id,
      observed_message_id,
      observed_payload_sha256,
      existing_payload_sha256,
      blocked_at_ns
    ) values (
      v_source_ledger_id,
      'SOURCE_LINEAGE_CONFLICT',
      v_outbox_id,
      v_message_id,
      v_payload_sha256,
      v_existing.payload_sha256,
      p_received_at_ns
    );
    return query select 'INTEGRITY_BLOCKED'::text, 'SOURCE_LINEAGE_CONFLICT'::text;
    return;
  end if;

  insert into public.vision_shadow_receipts(
    source_ledger_id,
    outbox_id,
    message_id,
    source_match_id,
    source_revision,
    source_event_id,
    source_payload_bytes,
    payload_sha256,
    transport_envelope_bytes,
    transport_envelope_sha256,
    dispatcher_id,
    dispatcher_key_id,
    dispatch_attempt_id,
    dispatch_signed_at_ns,
    dispatch_expires_at_ns,
    received_at_ns,
    appended_at_ns,
    event_type,
    event_summary,
    post_state_summary,
    ruleset_id,
    ruleset_version,
    ruleset_fingerprint,
    reducer_build_sha256,
    adopted_archive_fingerprint,
    authorization_record_fingerprint,
    source_envelope_fingerprint,
    event_fingerprint,
    state_fingerprint,
    review_history_head_sha256,
    review_position,
    scorer_copilot_case_fingerprint,
    scorer_copilot_signed_case_fingerprint,
    scorer_copilot_case_link_fingerprint,
    review_authorization_context_fingerprint,
    binding_generation,
    scorecheck_event_id,
    scorecheck_court_id,
    scorecheck_match_id
  ) values (
    v_source_ledger_id,
    v_outbox_id,
    v_message_id,
    v_source_match_id,
    v_source_revision,
    v_source_event_id,
    p_source_payload_bytes,
    v_payload_sha256,
    p_transport_envelope_bytes,
    v_transport_sha256,
    v_envelope ->> 'dispatcher_id',
    v_envelope ->> 'dispatcher_key_id',
    v_envelope ->> 'attempt_id',
    (v_envelope ->> 'signed_at_ns')::bigint,
    (v_envelope ->> 'expires_at_ns')::bigint,
    p_received_at_ns,
    v_appended_at_ns,
    v_payload #>> '{event_summary,event_type}',
    v_payload -> 'event_summary',
    v_payload -> 'post_state_summary',
    v_payload ->> 'ruleset_id',
    v_payload ->> 'ruleset_version',
    v_payload ->> 'ruleset_fingerprint',
    v_payload ->> 'reducer_build_sha256',
    v_payload ->> 'adopted_archive_fingerprint',
    v_payload ->> 'authorization_record_fingerprint',
    v_payload ->> 'envelope_fingerprint',
    v_payload ->> 'event_fingerprint',
    v_payload ->> 'state_fingerprint',
    v_payload ->> 'review_history_head_sha256',
    (v_payload ->> 'review_position')::bigint,
    v_payload ->> 'scorer_copilot_case_fingerprint',
    v_payload ->> 'scorer_copilot_signed_case_fingerprint',
    v_payload ->> 'scorer_copilot_case_link_fingerprint',
    v_payload ->> 'review_authorization_context_fingerprint',
    1,
    v_binding.scorecheck_event_id,
    v_binding.scorecheck_court_id,
    v_binding.scorecheck_match_id
  );

  return query select 'INSERTED'::text, null::text;
end;
$$;

create or replace function public.vision_jsonb_ints_as_text(p_value jsonb)
returns jsonb
language plpgsql
immutable
strict
set search_path = pg_catalog, public
as $$
declare
  v_number text;
  v_result jsonb;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select coalesce(
        jsonb_object_agg(entry.key, public.vision_jsonb_ints_as_text(entry.value)),
        '{}'::jsonb
      ) into v_result
      from jsonb_each(p_value) as entry;
      return v_result;
    when 'array' then
      select coalesce(
        jsonb_agg(public.vision_jsonb_ints_as_text(entry.value) order by entry.ordinality),
        '[]'::jsonb
      ) into v_result
      from jsonb_array_elements(p_value) with ordinality as entry(value, ordinality);
      return v_result;
    when 'number' then
      v_number := p_value #>> '{}';
      if v_number !~ '^-?(0|[1-9][0-9]*)$' then
        raise exception 'vision JSON contains a non-integer number' using errcode = '22023';
      end if;
      return to_jsonb(v_number);
    else
      return p_value;
  end case;
end;
$$;

create or replace function public.vision_read_shadow_receipts(
  p_source_ledger_id text,
  p_source_match_id text
)
returns table(record jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_block_code text;
  v_receipt_count integer;
  v_total_source_bytes bigint;
begin
  if p_source_ledger_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$' or
     p_source_match_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$' then
    raise exception 'invalid vision receipt read identity' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(public.vision_ledger_lock_key(p_source_ledger_id));
  perform pg_advisory_xact_lock(
    public.vision_binding_lock_key(p_source_ledger_id, p_source_match_id)
  );

  select block_code into v_block_code
  from public.vision_shadow_integrity_blocks
  where source_ledger_id = p_source_ledger_id;

  select
    count(*)::integer,
    coalesce(sum(
      octet_length(receipt.source_payload_bytes) +
      octet_length(receipt.transport_envelope_bytes)
    ), 0)::bigint
  into v_receipt_count, v_total_source_bytes
  from public.vision_shadow_receipts receipt
  where receipt.source_ledger_id = p_source_ledger_id
    and receipt.source_match_id = p_source_match_id;

  if v_receipt_count > 4096 or v_total_source_bytes > 33554432 then
    raise exception 'vision fixed read exceeds aggregate receipt bounds'
      using errcode = '54000';
  end if;

  return query select jsonb_build_object(
    'schema_version', '1.0',
    'row_kind', 'META',
    'integrity_block_code', v_block_code,
    'source_ledger_id', p_source_ledger_id,
    'source_match_id', p_source_match_id
  );

  return query
  select jsonb_build_object(
    'schema_version', '1.0',
    'row_kind', 'RECEIPT',
    'integrity_block_code', null,
    'source_ledger_id', receipt.source_ledger_id,
    'source_match_id', receipt.source_match_id,
    'outbox_id', receipt.outbox_id::text,
    'message_id', receipt.message_id,
    'source_revision', receipt.source_revision::text,
    'source_event_id', receipt.source_event_id,
    'source_payload_base64', replace(encode(receipt.source_payload_bytes, 'base64'), E'\n', ''),
    'payload_sha256', receipt.payload_sha256,
    'transport_envelope_base64', replace(encode(receipt.transport_envelope_bytes, 'base64'), E'\n', ''),
    'transport_envelope_sha256', receipt.transport_envelope_sha256,
    'dispatcher_id', receipt.dispatcher_id,
    'dispatcher_key_id', receipt.dispatcher_key_id,
    'dispatch_attempt_id', receipt.dispatch_attempt_id,
    'dispatch_signed_at_ns', receipt.dispatch_signed_at_ns::text,
    'dispatch_expires_at_ns', receipt.dispatch_expires_at_ns::text,
    'received_at_ns', receipt.received_at_ns::text,
    'appended_at_ns', receipt.appended_at_ns::text,
    'event_type', receipt.event_type,
    'event_summary', public.vision_jsonb_ints_as_text(receipt.event_summary),
    'post_state_summary', public.vision_jsonb_ints_as_text(receipt.post_state_summary),
    'ruleset_id', receipt.ruleset_id,
    'ruleset_version', receipt.ruleset_version,
    'ruleset_fingerprint', receipt.ruleset_fingerprint,
    'reducer_build_sha256', receipt.reducer_build_sha256,
    'adopted_archive_fingerprint', receipt.adopted_archive_fingerprint,
    'authorization_record_fingerprint', receipt.authorization_record_fingerprint,
    'source_envelope_fingerprint', receipt.source_envelope_fingerprint,
    'event_fingerprint', receipt.event_fingerprint,
    'state_fingerprint', receipt.state_fingerprint,
    'review_history_head_sha256', receipt.review_history_head_sha256,
    'review_position', receipt.review_position::text,
    'scorer_copilot_case_fingerprint', receipt.scorer_copilot_case_fingerprint,
    'scorer_copilot_signed_case_fingerprint', receipt.scorer_copilot_signed_case_fingerprint,
    'scorer_copilot_case_link_fingerprint', receipt.scorer_copilot_case_link_fingerprint,
    'review_authorization_context_fingerprint', receipt.review_authorization_context_fingerprint
  )
  from public.vision_shadow_receipts receipt
  where receipt.source_ledger_id = p_source_ledger_id
    and receipt.source_match_id = p_source_match_id
  order by receipt.source_revision;
end;
$$;

comment on table public.vision_match_bindings is
  'Immutable one-to-one source-match target binding. A new target requires a new source_match_id.';
comment on table public.vision_shadow_receipts is
  'Append-only authenticated vision evidence. Read only through verified fixed replay.';

revoke all on table public.vision_match_bindings
  from public, anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all on table public.vision_shadow_receipts
  from public, anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all on table public.vision_shadow_integrity_blocks
  from public, anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. Hard-cut the
-- ambient path now and for future public-schema functions. Existing non-vision
-- application role grants remain explicit and are not inferred by this slice.
alter default privileges in schema public revoke execute on functions from public;
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public
  from vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all privileges on all tables in schema public
  from public, vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all privileges on all sequences in schema public
  from public, vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke create on schema public
  from public, vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
grant usage on schema public
  to vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;

revoke all on function public.vision_reject_immutable_mutation()
  from anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all on function public.vision_binding_lock_key(text, text)
  from anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all on function public.vision_ledger_lock_key(text)
  from anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all on function public.vision_publish_match_binding(text, text, uuid, uuid, uuid, bigint, text, bigint)
  from anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all on function public.vision_accept_shadow_receipt(bytea, bytea, bigint)
  from anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all on function public.vision_jsonb_ints_as_text(jsonb)
  from anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;
revoke all on function public.vision_read_shadow_receipts(text, text)
  from anon, authenticated, service_role,
       vision_shadow_ingest, vision_shadow_binding_publisher, vision_shadow_reader;

grant execute on function public.vision_publish_match_binding(text, text, uuid, uuid, uuid, bigint, text, bigint)
  to vision_shadow_binding_publisher;
grant execute on function public.vision_accept_shadow_receipt(bytea, bytea, bigint)
  to vision_shadow_ingest;
grant execute on function public.vision_read_shadow_receipts(text, text)
  to vision_shadow_reader;

-- Assert effective privileges, not merely ACL text. Each NOLOGIN/NOINHERIT
-- capability may execute exactly one intended public function and nothing else.
do $$
declare
  v_capability text;
  v_signature text;
  v_expected_oid oid;
  v_effective_functions bigint;
  v_expected_functions bigint;
  v_role record;
begin
  for v_capability, v_signature in
    select expected.capability, expected.signature
    from (values
      ('vision_shadow_ingest', 'public.vision_accept_shadow_receipt(bytea,bytea,bigint)'),
      (
        'vision_shadow_binding_publisher',
        'public.vision_publish_match_binding(text,text,uuid,uuid,uuid,bigint,text,bigint)'
      ),
      ('vision_shadow_reader', 'public.vision_read_shadow_receipts(text,text)')
    ) as expected(capability, signature)
  loop
    select role.* into v_role
    from pg_roles role
    where role.rolname = v_capability;
    if not found then
      raise exception 'vision capability role % is missing', v_capability using errcode = '55000';
    end if;
    if v_role.rolcanlogin or v_role.rolsuper or v_role.rolinherit or
       v_role.rolcreaterole or v_role.rolcreatedb or v_role.rolreplication or
       v_role.rolbypassrls then
      raise exception 'vision capability role % has unsafe attributes', v_capability
        using errcode = '55000';
    end if;
    if exists (
      select 1 from pg_auth_members membership
      where membership.member = v_role.oid or membership.roleid = v_role.oid
    ) then
      raise exception 'vision capability role % has unexpected membership', v_capability
        using errcode = '55000';
    end if;

    v_expected_oid := to_regprocedure(v_signature)::oid;
    select
      count(*),
      count(*) filter (where procedure.oid = v_expected_oid)
    into v_effective_functions, v_expected_functions
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and has_function_privilege(v_capability, procedure.oid, 'EXECUTE');
    if v_expected_oid is null or
       v_effective_functions <> 1 or v_expected_functions <> 1 then
      raise exception 'vision capability role % function authority is not exact', v_capability
        using errcode = '55000';
    end if;

    if exists (
      select 1
      from pg_class object
      join pg_namespace namespace on namespace.oid = object.relnamespace
      where namespace.nspname = 'public'
        and object.relkind in ('r', 'p', 'v', 'm', 'f')
        and (
          has_table_privilege(v_capability, object.oid, 'SELECT') or
          has_table_privilege(v_capability, object.oid, 'INSERT') or
          has_table_privilege(v_capability, object.oid, 'UPDATE') or
          has_table_privilege(v_capability, object.oid, 'DELETE') or
          has_table_privilege(v_capability, object.oid, 'TRUNCATE') or
          has_table_privilege(v_capability, object.oid, 'REFERENCES') or
          has_table_privilege(v_capability, object.oid, 'TRIGGER')
        )
    ) then
      raise exception 'vision capability role % has effective table authority', v_capability
        using errcode = '55000';
    end if;
    if exists (
      select 1
      from pg_class object
      join pg_namespace namespace on namespace.oid = object.relnamespace
      where namespace.nspname = 'public'
        and object.relkind = 'S'
        and (
          has_sequence_privilege(v_capability, object.oid, 'USAGE') or
          has_sequence_privilege(v_capability, object.oid, 'SELECT') or
          has_sequence_privilege(v_capability, object.oid, 'UPDATE')
        )
    ) then
      raise exception 'vision capability role % has effective sequence authority', v_capability
        using errcode = '55000';
    end if;
    if has_schema_privilege(v_capability, 'public', 'CREATE') or
       not has_schema_privilege(v_capability, 'public', 'USAGE') then
      raise exception 'vision capability role % schema authority is unsafe', v_capability
        using errcode = '55000';
    end if;
  end loop;
end
$$;
