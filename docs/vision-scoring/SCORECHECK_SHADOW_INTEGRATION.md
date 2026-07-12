# ScoreCheck Vision Shadow Integration

**Status:** source schema-v3/outbox-v2 contract and bounded dispatcher
authentication implemented; ScoreCheck receipt/projection implementation is
pending

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
  -> replay-derived vision_shadow_match_projection
  -> read-only scorer/admin comparison UI

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
policy. A known revocation must not intersect any part of the signed envelope
lifetime, even when verification occurs before the scheduled revocation. The
dispatcher key grants only delivery attribution. It is not a human
score-authority, authorizer, case-producer, policy-assessment, or review key.
The Python transport boundary contains no database, network, filesystem,
process, event-store, reducer, or official-scoring integration. It validates
delivery attribution only and deliberately has no delivery checkpoint.

Exact payload retries are safe. Reusing `(source_ledger_id, outbox_id)` or
`message_id` with different bytes is a terminal integrity conflict for that
source until an operator investigates it.

## Trusted match binding

`vision_match_bindings` is configuration published by a trusted ScoreCheck
administrator, never inferred from names or accepted from a delivered payload.
One active generation maps:

```text
(source_ledger_id, source_match_id)
    -> (event_id, court_id, match_id, binding_generation)
```

The adapter verifies that the bound court still names the bound match when a
receipt is accepted. A reassignment closes the old binding generation; it does
not retarget historical receipts. Missing, ambiguous, stale, or mismatched
bindings fail closed and retain the message in the dispatcher's retry/dead
letter state without writing a ScoreCheck receipt.

## ScoreCheck persistence

The ScoreCheck source table is append-only `vision_shadow_receipts`. Its
identity is `(source_ledger_id, outbox_id)`, and it stores the exact transport
envelope, exact source payload bytes, all source fingerprints, the protected
binding generation, and receipt time. Database constraints reject mutable
upserts and identity reuse.

`vision_shadow_match_projection` is a convenience cache derived only by replay
of receipts ordered by source revision. The replay requires contiguous
revisions per source match, exact idempotency, matching fingerprints, and a
single reducer-build/ruleset lineage. Gaps or conflicts make the projection
`INTEGRITY_BLOCKED`; they do not borrow an official score to fill the gap.

Neither table has a trigger, foreign-key cascade, stored procedure, or UI action
that writes an official scoring table. Receipt deletion and correction are
absent in V0. Whole-history rollback is checked against an externally protected
ScoreCheck receipt checkpoint.

## Read-only UI semantics

The comparison UI labels this data as a vision-ledger observation. It may show:

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
- a database integration test proves ingest changes only vision receipt and
  projection tables;
- attempts to target `scorer_shadow_states`, change the mutation-permission
  literal, supply a court/match binding, or add unknown fields fail closed;
- invalid/revoked dispatcher signatures, oversized payloads, duplicate JSON
  keys, non-canonical bytes, hash mismatches, and clock violations fail closed;
- exact retry is idempotent; same identity with different bytes blocks the
  source;
- missing/stale/ambiguous bindings and court reassignment never retarget a
  receipt;
- out-of-order or skipped revisions cannot advance the projection;
- tampered receipt, projection, delivery checkpoint, or source fingerprint is
  detected by full replay;
- UI tests prove that no receipt component renders or invokes an official score
  action;
- a promoted scorer handoff test proves vision receipts are absent from
  `scorer_shadow_states` and cannot be adopted into the broadcast score.

The bounded transport implementation began only after the schema-3 source
payload was frozen, so it binds the exact canonical contract instead of a
temporary compatibility layer. ScoreCheck receipt/projection persistence is
the next implementation slice and remains absent here.
