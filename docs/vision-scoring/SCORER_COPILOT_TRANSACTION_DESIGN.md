# Scorer-Copilot Transaction Design

**Status:** schema-v3 transaction/replay path and mandatory adversarial matrix
implemented and independently re-audited; production-scale ceiling benchmarks
remain an operational follow-up

**Decision date:** 2026-07-12

## Purpose

The scorer copilot may prepare evidence and advice, but only a human-signed
`AuthorizationCommand` can request a score transition. The trusted store must
bind the exact review presentation to the exact authorized envelope and shadow
outbox row in one SQLite transaction. No review signature, model signature,
case record, disposition, or adjudication is score authority.

This is a hard-cut V0 design. There is no compatibility schema, migration path,
feature flag, official ScoreCheck write, or correction event.

## Explicit assumptions and tradeoffs

- The SQLite process, protected policy/archive loader, reducer-build pin,
  monotonic clock, immutable-object-store root, and external checkpoint writer
  are trusted deployment inputs. Uploaded case or event bytes are not.
- Full replay is favored over snapshot trust. Replay cost is bounded by fixed
  per-match record and aggregate-byte ceilings.
- A normal score-confirmation click does not require a second signed review
  disposition. The human-signed `AuthorizationCommand` is the approval. A case
  with no review actions therefore has sequence zero and the complete signed
  case fingerprint as its review head. The unsigned case fingerprint is content
  lookup only and is never journal identity.
- Signed dispositions are for non-score outcomes, conflict handling, and
  escalation. If one has been recorded, scoring from that case is forbidden
  until a referee adjudication or later signed observed-outcome record resolves
  the exact current head.
- Losing an immutable clip after it was verified does not change its content
  identity, but the UI must not present or authorize a case unless every clip
  needed for that action is resident and byte-verified at that time.
- Review-signature revocation is evidence-integrity state, not an alternate
  route to mutate or undo an already human-authorized rule event. Any ledger
  compromise or authorization-key revocation still fails closed under the
  authorization archive rules.
- A newly effective case-producer or review-key revocation makes an affected
  case ineligible for any new presentation, action, or link. Historical review
  acceptance is replayed under revocation truth as of acceptance, so this
  evidence-only revocation never removes or undoes an already linked
  human-authorized event. Authorization-envelope revocation retains the event
  ledger's terminal integrity-block semantics.
- Without a case supersession/abandonment workflow, V0 permits only one case
  for a `(match_id, rally_id, state_revision)` tuple. An alternate presentation
  is a conflict, not an implicit replacement.

## Trust-separated record flow

```text
untrusted observations/models
        |
        v
SignedScorerCopilotCase + immutable clip references
        |
        v
case-producer attestation (assessment key, separate signature domain)
        |
        v
trusted case admission
  - strict canonical parsing
  - producer and optional assessment signature verification
  - policy-current-at-signing proof from adoption history
  - complete clip-generation lease and byte verification
  - current match/ruleset/revision check
        |
        v
append-only signed review journal (optional)
        |
        v
ReviewAuthorizationContext derived by the store from the persisted signed head
        |
        v
human-signed AuthorizationCommand
        |
        v
authorizer-countersigned AuthorizedRuleEvent
        |
        v
one BEGIN IMMEDIATE transaction
  - replay case journal and event ledger
  - verify exact case/head/context/envelope
  - reduce event
  - append authorization/event/state/outbox/idempotency/link rows
  - replay proposed result before COMMIT
        |
        v
shadow-only message; official ScoreCheck mutation remains impossible
```

## Required case-producer attestation

Persisted cases require a `SignedScorerCopilotCase` (name may change before the
schema is frozen) signed by a protected `TrustedAssessmentKey` under a domain
that is distinct from policy-assessment, review-disposition, adjudication,
human-command, and authorizer signatures. It binds:

- the complete canonical case and case fingerprint;
- producer and key identifiers;
- the exact authorization-policy generation and trust domain;
- the preparation/signing time;
- the case schema version.

This signature proves attribution and tamper evidence only. The key cannot sign
a human command or authorize an event. Case admission must prove that its
policy was ledger-current when signed and that current archive revocation truth
still accepts the key.

The store persists both identities: `case_fingerprint` for the exact unsigned
content and `signed_case_fingerprint` for provenance and journal identity. A
second signature over identical unsigned bytes is not an exact retry and is
rejected as an alternate-case conflict. Every review action, derived context,
authorization link, history receipt, and copilot idempotency key binds the
signed-case fingerprint.

If a case includes `SignedPolicyAssessment`, admission verifies that signature,
accepted assessment-policy fingerprint, match scope, causal time, exact signing
policy generation, verification archive generation, and current revocation
status. The store selects the most recent policy adoption whose
`adopted_at_ns <= signed_at_ns`; exact equality is valid, while a signature
before first adoption or under a staged-but-never-current policy fails. An
absent signed assessment is permitted only for a human-direct path. It can
never be upgraded into an assessment-assisted command later.

## Clip admission

For every `ReviewClipRef`, one immutable-generation read lease remains held
through admission commit. The trusted boundary must:

1. require the generation descriptor to contain exactly the declared manifest
   and rendered-clip hashes;
2. stage and hash both objects through safe descriptors;
3. require manifest bytes to equal the canonical embedded
   `ReviewClipManifest` bytes;
4. require the rendered object size to equal `rendered_size_bytes` exactly;
5. reject duplicate rendered hashes across roles;
6. reject primary or context-only footage beyond the assessment cutoff;
7. allow later footage only in the explicit next-server reconciliation role
   and only inside its bounded causal window.

Clip hashes prove byte identity, not live capture, clock correctness, camera
identity, or physical truth. Those claims remain separately attested evidence.
The current two-object clip generation proves canonical manifest identity and
rendered-object identity/size only. Its `source_sha256`, decoder contract,
frame/timestamp selection, and render-profile fields are signed manifest
claims; it does not prove source residency or rendered derivation. A stronger
claim requires a leased source-object reference or a separately trusted
renderer/capture derivation attestation. The store also binds case material,
not proof that a human watched every frame or exact UI pixels; that would need a
separate signed presentation/view receipt and UI-build commitment.

## Signed journal semantics

The source of truth is an append-only per-match review journal. Mutable lane,
status, and head columns are projections checked by replay.

- The first action names the complete signed-case fingerprint as
  `previous_record_fingerprint` and has `expected_case_sequence = 0`.
- After acceptance, the next head is the complete
  `SignedReviewDisposition.fingerprint()`, never the unsigned disposition
  fingerprint.
- Adjudications name exact accepted signed-disposition fingerprints and the
  immediately previous signed head. They cannot refer to unsigned content
  fingerprints as journal identities.
- After adjudication, the next head is the complete signed-adjudication
  fingerprint. A later disposition may follow any exact current signed head;
  an adjudication may consider only accepted signed dispositions for the same
  case.
- A newly accepted signature time cannot precede the case, prior accepted
  action, or any disposition it adjudicates.
- Review idempotency keys are globally unique across record types. An exact
  retry returns its original result; the same key with different bytes fails.
  Disposition and adjudication keys cannot use the reserved `copilot-v1:`
  namespace or the derived `case-admission-v1:` namespace.
- Each case accepts at most `MAX_REVIEW_ACTIONS` actions. Input sequence values
  range from zero through `MAX_REVIEW_ACTIONS - 1`; a derived post-action
  context may reach `MAX_REVIEW_ACTIONS`.
- Every accepted record stores the archive generation used for verification.
  A retained policy that was not ledger-current at signature time is rejected.

`ReviewAuthorizationContext` is never trusted from caller bytes. The store
derives it from the canonical case and replayed current signed head, returns it
to the command-signing surface, and recomputes it inside the append transaction.
The store reacquires and byte-verifies every clip when deriving a presentation
context and again during atomic append, holding leases until the operation
finishes. Admission-only verification is insufficient after object retirement.

## Atomic case-to-event link

The dedicated copilot append API is the only API permitted to accept an
`ASSESSMENT_ASSISTED` command or a `copilot-v1:` idempotency key. Generic append
accepts human-direct envelopes only and rejects the reserved namespace.

Inside one `BEGIN IMMEDIATE` transaction, the copilot append must prove:

- the case exists, is unlinked, and its complete journal replays;
- both unsigned and signed case identities match the persisted admission;
- its context equals the store-derived current context byte-for-byte;
- `command.idempotency_key == copilot_idempotency_key(context)`;
- match, rally, set, state revision, ruleset, and event sequence match the case;
- the case still targets the current `IN_PROGRESS` set; the gap after one set
  completes and before the next seed is not an active rally context;
- `related_rally_id` equals the case rally;
- point/replay event evidence equals the case evidence exactly;
- event creation, command issuance, authorization, verification, and commit
  times do not precede case admission or move backward;
- the command policy was ledger-current at assessment signing (when assisted),
  command issuance, and authorization;
- a sequence-zero assisted command carries the exact case assessment and valid
  signed assessment and matches its exact recommended intent;
- a human-direct sequence-zero command is allowed after viewing the case;
- after a journal action, assistance is forbidden and only a human-direct exact
  signed/adjudicated observed outcome may be linked; it must match
  `POINT_AWARDED` or `REPLAY_NO_POINT`;
- `NO_DECISION`, `CASE_INVALID`, and `ESCALATE` heads cannot link a score event;
- one case cannot link twice and one event cannot link to two cases.

The committed `CaseAuthorizationLink`, its fingerprint, the exact outbox ID,
and the context fingerprint are included in the outbox payload and ledger hash
chain. Post-write replay checks all event, case, journal, link, projection,
idempotency, and outbox rows before commit.

Every event row stores the exact review position and history head visible at
its append. Position zero means review genesis; position `N` must equal the
fully replayed `copilot_history` head at row `N`. A copilot event binds the head
*after* its same-transaction authorization-link receipt. A direct event binds
the current prefix that existed before it. Timestamps never infer this order,
because independent transactions can have equal trusted nanosecond values.

## SQLite source tables and projections

The schema contains:

- `copilot_cases`: canonical signed case, immutable identity, current-head and
  linked-state projections;
- `copilot_journal`: canonical signed actions plus a per-match hash-chain
  position and exact archive verification generation;
- `copilot_authorization_links`: canonical one-to-one context/event link;
- `copilot_history`: one cross-record per-match review chain covering case
  admissions, journal actions, and links;
- `request_identities`: a global cross-kind idempotency registry used by direct
  events, case admissions, dispositions, adjudications, and copilot links;
- existing authorization, event, state, idempotency, archive, and shadow-outbox
  tables.

Case and journal rows are append-only source records. Projection fields may be
updated only by fixed store code and must equal full replay. No delete, replace,
upsert, purge, compatibility, or arbitrary transaction-callback API exists.

The match projection and external `LedgerCheckpoint` additionally bind
`review_position`, case/action/link counts, and a domain-separated per-match
review-history head, so rolling back an unresolved or unlinked review is
detectable even when the score revision did not change. Review position equals
the sum of those counts. Counts never decrease; equal position requires exact
count/head equality, and advancing position requires a changed head.

Case admission has no caller-selected request key. The store derives
`case-admission-v1:<signed_case_fingerprint>` and reserves that prefix from
every event and review-action API. An exact signed-case retry returns the
original historical admission receipt and prefix checkpoint after ledger
integrity replay. A retry does not establish current presentation or linking
eligibility and therefore does not reopen or hash media; current use is checked
only by deriving a fresh context. A second producer signature over the same
unsigned case is a conflict, not an idempotent retry.

## Fixed bounds

The schema and tests pin these conservative V0 ceilings:

- 512 cases per match;
- 32 actions per case and 2,048 actions per match;
- 512 KiB per canonical signed review record, below the configured SQLite
  768 KiB value limit;
- 128 MiB cumulative review BLOB/text bytes per match;
- 8 clips and no more than 512 MiB declared rendered bytes per case;
- existing event-ledger row and aggregate envelope/archive budgets;
- no caller-configurable clock skew or maximum-age exception.

All count and aggregate-byte checks occur before fetching BLOBs. Replay streams
bounded rows rather than materializing the complete history.

## Required adversarial tests

- unsigned-head signer substitution;
- alternate producer signatures over one unsigned case and reserved
  cross-record idempotency-key squatting;
- invalid case-producer and policy-assessment signatures;
- policy staged but never current, or signature backdated before adoption;
- clip manifest mismatch, missing object, same bytes under two roles, and
  generation replacement during a lease;
- stale case revision, stale journal head, concurrent actions, and concurrent
  double authorization;
- non-score disposition followed by forbidden score link;
- event outcome/evidence/rally mismatch;
- same idempotency key with different case, record type, envelope, or bytes;
- failure after every proposed insert, proving complete rollback;
- tampered case, signed journal record, link, outbox ID, projection, and hash
  chain;
- scheduled revocation becoming effective after admission;
- whole-file rollback checked against an external monotonic checkpoint;
- rollback of an unlinked case/action while score revision is unchanged;
- oversized row, count, aggregate-byte, depth, duplicate-key, and SQLite
  corruption inputs.

Only after those tests pass may the review UI or ScoreCheck shadow adapter treat
the database as a trusted audit source.
