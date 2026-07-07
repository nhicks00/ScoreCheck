-- 011: Instant scoring sessions.
-- Fan verification (YouTube chat codes) was removed in 2026-07. Fans now get a
-- scorer session immediately after entering a display name, so new claims no
-- longer carry verification codes. Historical columns are kept for audit data
-- but are no longer written.

alter table public.scorer_claims
  alter column verification_code_hash drop not null,
  alter column verification_code_label drop not null;

comment on column public.scorer_claims.verification_code_hash is
  'Legacy: chat-code verification removed 2026-07; new claims leave this null.';
comment on column public.scorer_claims.verification_code_label is
  'Legacy: chat-code verification removed 2026-07; new claims leave this null.';
