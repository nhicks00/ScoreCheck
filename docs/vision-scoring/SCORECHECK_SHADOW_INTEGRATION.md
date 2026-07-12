# ScoreCheck Vision Shadow Integration

**Status:** source schema-v3/outbox-v2 contract, bounded dispatcher
authentication, immutable ScoreCheck receipt persistence, and fixed verified
read/replay implemented. The externally protected monotonic ScoreCheck receipt
checkpoint is not implemented and remains a deployment gate. No HTTP endpoint,
server action, or UI consumes this projection yet.

**Decision date:** 2026-07-12

## Purpose

Move an accepted vision-ledger outbox record into ScoreCheck as evidence for a
human-facing comparison and review surface. This path must remain incapable of
changing `score_states`, overlays, or any other official/broadcast score.

This is a hard-cut V0 design. It has no compatibility path, automatic score
application, correction event, or feature flag.

## Repository finding that changes the design

ScoreCheck's existing `scorer_shadow_states` table is **not** an isolated
vision sink. A promoted scorer can call `resolvePromotionHandoffWithShadow()`
and copy that table's state into the official score and broadcast overlay.
Consequently, the vision service, dispatcher, ingest adapter, and review UI
must never insert into or update any of these existing mutation-capable paths:

- `score_states`;
- `overlay_states`;
- `score_actions`;
- `scorer_shadow_states`;
- scorer-session action, handoff, point, undo, correction, or admin-score
  routes;
- `court_flags` when a flag can trigger an existing score-adoption workflow.

The word *shadow* in the vision ledger therefore does not mean ScoreCheck's
current scorer shadow table.

## Assumptions and tradeoffs

- The vision SQLite ledger, its external monotonic checkpoint, the dispatch
  signer, the ScoreCheck match-binding publisher, and the ScoreCheck ingest
  adapter are trusted deployment inputs. Network bytes and caller-provided
  match/court identifiers are not.
- Delivery is at least once. Exact idempotency is preferred over mutable
  delivery markers in the append-only source ledger.
- The ScoreCheck copy is a review/read projection, not a second authorization
  source. Loss or corruption of that projection is repaired from the source
  ledger; it never changes the ledger's decision.
- ScoreCheck match UUIDs and vision match identifiers are assumed to be
  different namespaces. A protected deployment-owned binding is mandatory;
  an outbox payload cannot choose a ScoreCheck court or match.
- A compact, replay-derived display summary may be included in the outbox.
  Full `MatchState` bytes are intentionally excluded because their current
  bound is 512 KiB while the outbox is capped at 16 KiB.
- During this phase, a human who wants the official score changed must still
  use the existing authenticated official-scoring workflow separately. A
  future bridge would need its own authority and safety review; it is not
  implied by this design.

## Boundary and data flow

```text
replay-verified SQLite ledger
  -> append-only shadow_outbox row
  -> read-only dispatcher + externally protected checkpoint
  -> authenticated transport envelope
  -> fixed ScoreCheck vision-ingest adapter
  -> append-only vision_shadow_receipts
  -> fixed decimal-text/base64 receipt-read RPC
  -> historical-signature-verified in-process projection
  -> [STOP: no endpoint or UI implemented]

There is no edge to score_states, overlay_states, score_actions,
scorer_shadow_states, or an official scoring route.
```

The dispatcher process receives read-only access to the SQLite ledger and a
transport-signing key. It receives no Supabase service-role secret, scorer
token, admin token, or official scoring credential. The ingest adapter exposes
one fixed insert operation and does not accept a table name, SQL fragment,
score action, session token, or official-state payload.

## Source outbox contract

The exact schema is frozen with the schema-3 ledger. At minimum, a delivered
source payload binds:

- exact `topic` and `target`, including
  `SHADOW_ONLY_NO_OFFICIAL_SCORECHECK_MUTATION`;
- `official_scorecheck_mutation_permitted: false`;
- source match, revision, event, message, and global outbox identities;
- authorized-envelope, authorization-record, event, post-state,
  reducer-build, policy-archive, and payload fingerprints;
- for a scorer-copilot event, case, review-context, and
  case-authorization-link fingerprints;
- a compact event presentation sufficient to distinguish point, replay,
  side-switch, timeout, and set-seed observations without fetching unbound
  bytes;
- a required bounded post-state display summary whose current-set and
  last-completed-set members are explicitly nullable.

The event fingerprint remains the commitment to the exact complete event.
Large evidence-reference arrays must not be copied merely for convenience: a
count plus a domain-separated evidence-set fingerprint is sufficient for a
bounded transport presentation unless the frozen copilot contract establishes
a tighter worst-case bound.

The ScoreCheck adapter rejects unknown fields, versions, topics, targets, event
types, hash formats, or a mutation permission other than the literal boolean
`false`. It recomputes the canonical payload fingerprint before persistence.

## Transport authentication

A SHA-256 payload fingerprint is not sender authentication. Every request is
wrapped in a separate domain-separated signed transport envelope containing:

- source-ledger deployment ID;
- dispatcher key ID and algorithm;
- exact payload bytes and payload fingerprint;
- outbox ID and message ID;
- dispatch-attempt ID, signing time, and bounded expiry;
- transport schema version.

The ingest adapter uses a protected current/revoked dispatcher-key registry,
verifies the signature over canonical bytes, applies fixed byte/depth/count
limits before parsing, and rejects signing times outside its protected clock
policy. Source append, dispatcher signing, and protected ScoreCheck receipt
timestamps use Unix-epoch nanoseconds but may come from distinct clocks. The
protected transport policy's explicit skew bound is authoritative for
signed-versus-received ordering; the database does not impose a contradictory
zero-skew check. Exact append-versus-sign ordering is likewise not assumed
until the source clock contract and Python dispatcher parity are explicitly
implemented. A known revocation must not intersect any part of the signed
envelope lifetime, even when verification occurs before the scheduled
revocation. The
dispatcher key grants only delivery attribution. It is not a human
score-authority, authorizer, case-producer, policy-assessment, or review key.
The Python transport boundary contains no database, network, filesystem,
process, event-store, reducer, or official-scoring integration. It validates
delivery attribution only and deliberately has no delivery checkpoint.

Exact payload retries are safe. Reusing `(source_ledger_id, outbox_id)` or
`message_id` with different bytes is a terminal integrity conflict for that
source until an operator investigates it.

## Trusted match binding

`vision_match_bindings` is immutable configuration published by a trusted
ScoreCheck administrator, never inferred from names or accepted from a
delivered payload. Exactly one row maps:

```text
(source_ledger_id, source_match_id)
    -> (event_id, court_id, match_id)
```

The binding cannot be updated, closed, rotated, or retargeted. A different
ScoreCheck match requires a new source-ledger `source_match_id`. Binding
publication and receipt admission serialize on the same advisory lock. The
adapter requires the authenticated payload's `appended_at_ns` to be at or after
the binding's `active_from_ns`, then verifies that the bound court still names
the bound match. Missing, pre-binding, or reassigned bindings fail closed and
retain the message in the dispatcher's retry/dead-letter state without writing
a receipt.

## ScoreCheck persistence

The ScoreCheck source table is append-only `vision_shadow_receipts`. Its
identity is `(source_ledger_id, outbox_id)`, and it stores the exact transport
envelope, exact source payload bytes, all source fingerprints, the protected
binding target, literal binding generation `1`, and receipt time. Database
constraints and immutable-history triggers reject updates, deletion, mutable
upserts, and identity reuse.

There is no database projection or directly selectable consumer table. A fixed
read function returns one metadata row plus bounded receipt rows, capped at
4,096 records and 32 MiB of stored source/envelope bytes before base64 encoding;
the TypeScript boundary independently caps the total returned object graph at
48 MiB. It encodes
exact bytes as canonical base64 and every database integer, including integers
nested in event/post-state JSON, as canonical decimal text. The TypeScript read
adapter validates every derived column against the exact payload and re-runs
historical Ed25519 verification before returning an in-process projection.
Replay requires contiguous revisions, exact identities, and one
reducer-build/ruleset lineage. The database keeps the protected target binding
only as internal receipt provenance: target UUIDs and binding generation never
cross the fixed read wire or public projection. Target association must not be
shown until a separately protected binding attestation/resolver exists. Gaps
or conflicts yield `INTEGRITY_BLOCKED`; replay never borrows an official score.

The only successful non-empty public status is
`VERIFIED_RECEIPT_PREFIX`. It means exactly that the returned bounded receipt
prefix passed the fixed wire, derived-column, lineage, and retained historical
dispatcher-signature checks. It does not mean the prefix is rollback-complete,
that its referenced human/model/media evidence has been independently
reverified, or that any score, policy, training, evaluation, or deployment
action is ready.

No vision function, trigger, foreign key, or UI action writes an official
scoring table. Receipt deletion and correction are absent in V0. No direct
table `SELECT` grants exist: dedicated NOLOGIN roles may execute only their
fixed publish, ingest, or verified-read function. The migration removes stale
memberships in both directions and stale direct object privileges, removes
ambient `PUBLIC` function execution now and by default, and asserts effective
catalog privileges for each capability role; deployment
must then explicitly grant each capability to its exact authenticated
principal. Whole-history rollback is
**not yet checked** because the externally protected monotonic ScoreCheck
receipt checkpoint remains unimplemented.

## Future read-only UI semantics

No endpoint or UI is implemented in this phase. A future comparison UI may be
built only after a protected target-binding attestation/resolver exists; it
must label this data as a vision-ledger observation. It may show:

- authorized event and revision;
- compact post-event score summary;
- human/case/review fingerprints and verification status;
- divergence from the current official score;
- clip/evidence availability through separately authorized read endpoints;
- delivery gap, stale binding, revocation, or integrity-blocked state.

It must not expose **Apply**, **Adopt shadow**, **Confirm point**, **Undo**, or
**Correct score** controls from a vision receipt. Navigation to the existing
manual scorer is allowed only as a visibly separate workflow with its existing
authentication and a freshly entered action; it cannot pre-submit a score
mutation on behalf of the receipt.

## Required enforcement tests

- a repository guard fails if the vision adapter imports or calls official
  scoring modules/routes or names any forbidden mutation table;
- a database integration test proves ingest changes only vision binding,
  receipt, and integrity-block tables;
- attempts to target `scorer_shadow_states`, change the mutation-permission
  literal, supply a court/match binding, or add unknown fields fail closed;
- invalid/revoked dispatcher signatures, oversized payloads, duplicate JSON
  keys, non-canonical bytes, hash mismatches, and clock violations fail closed;
- exact retry is idempotent; same identity with different bytes blocks the
  source;
- missing/pre-binding/stale bindings and court reassignment never retarget a
  receipt;
- out-of-order or skipped revisions cannot advance the projection;
- tampered receipt or source fingerprint is detected by full authenticated
  replay; checkpoint tampering tests remain gated on checkpoint implementation;
- UI tests prove that no receipt component renders or invokes an official score
  action;
- a promoted scorer handoff test proves vision receipts are absent from
  `scorer_shadow_states` and cannot be adopted into the broadcast score.

The bounded transport implementation began only after the schema-3 source
payload was frozen, so it binds the exact canonical contract instead of a
temporary compatibility layer. Receipt persistence and verified read/replay
are implemented; deployment must not treat this slice as rollback-complete
until the external ScoreCheck checkpoint exists.

## Verification scope

The TypeScript contracts, repository isolation guards, golden cross-language
transport fixture, and SQL/PLpgSQL syntax are tested locally. Run the repeatable
plain-PostgreSQL behavioral test from `apps/web` with:

```bash
npm run test:vision-postgres
```

The harness uses the digest-pinned PostgreSQL 15 image, publishes no host port,
creates fixed minimal `auth.users` and side-effect-recording `realtime.send`
stubs, applies the complete ordered migration chain from `001` through `016`,
then applies current migration `017` and the fixed SQL fixture. It performs
idempotent preflight cleanup and removes its uniquely named container on normal
completion, failure, timeout, `SIGHUP`, `SIGINT`, or `SIGTERM`; it does not start
Docker or Colima.

The fixture proves the migration's effective role catalog assertions,
immutable binding/receipt behavior, `INSERTED` and `EXACT_RETRY`, bounded fixed
read shape, decimal-text nested integers, absence of target fields, terminal
conflict behavior, exact `42501` official-table and cross-RPC denials, and RLS
protection after an accidental direct `SELECT` grant. It also inventories live
public-table defaults that depend on public-schema functions, proves a
production-like explicitly granted `service_role` can execute current-schema
default inserts, and proves migration `002`'s overlay broadcast trigger still
records its `realtime.send` side effect after `017` while direct execution of
the trigger function remains denied.

This is a plain PostgreSQL 15 test, not a complete Supabase deployment test.
Supabase/PostgREST RPC exposure, JWT-to-role mapping, and deployment-principal
membership must still be proven in the real integration environment before
release.
