# Scorer-Copilot Transaction Design

**Status:** implementation contract; persistence is not complete until every
invariant below has an adversarial test

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
  with no review actions therefore has sequence zero and the case fingerprint
  as its review head.
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

## Trust-separated record flow

```text
untrusted observations/models
        |
        v
ScorerCopilotCase + immutable clip references
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

If a case includes `SignedPolicyAssessment`, admission verifies that signature,
accepted assessment-policy fingerprint, match scope, causal time, exact current
archive generation, and current revocation status. An absent signed assessment
is permitted only for a human-direct path. It can never be upgraded into an
assessment-assisted command later.

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

## Signed journal semantics

The source of truth is an append-only per-match review journal. Mutable lane,
status, and head columns are projections checked by replay.

- The first action names the case fingerprint as `previous_record_fingerprint`
  and has `expected_case_sequence = 0`.
- After acceptance, the next head is the complete
  `SignedReviewDisposition.fingerprint()`, never the unsigned disposition
  fingerprint.
- Adjudications name exact accepted signed-disposition fingerprints and the
  immediately previous signed head. They cannot refer to unsigned content
  fingerprints as journal identities.
- A newly accepted signature time cannot precede the case, prior accepted
  action, or any disposition it adjudicates.
- Review idempotency keys are globally unique across record types. An exact
  retry returns its original result; the same key with different bytes fails.
- Each case accepts at most `MAX_REVIEW_ACTIONS` actions. Input sequence values
  range from zero through `MAX_REVIEW_ACTIONS - 1`; a derived post-action
  context may reach `MAX_REVIEW_ACTIONS`.
- Every accepted record stores the archive generation used for verification.
  A retained policy that was not ledger-current at signature time is rejected.

`ReviewAuthorizationContext` is never trusted from caller bytes. The store
derives it from the canonical case and replayed current signed head, returns it
to the command-signing surface, and recomputes it inside the append transaction.

## Atomic case-to-event link

The dedicated copilot append API is the only API permitted to accept an
`ASSESSMENT_ASSISTED` command or a `copilot-v1:` idempotency key. Generic append
accepts human-direct envelopes only and rejects the reserved namespace.

Inside one `BEGIN IMMEDIATE` transaction, the copilot append must prove:

- the case exists, is unlinked, and its complete journal replays;
- its context equals the store-derived current context byte-for-byte;
- `command.idempotency_key == copilot_idempotency_key(context)`;
- match, rally, set, state revision, ruleset, and event sequence match the case;
- `related_rally_id` equals the case rally;
- point/replay event evidence equals the case evidence exactly;
- event creation, command issuance, authorization, verification, and commit
  times do not precede case admission or move backward;
- the command policy was ledger-current at assessment signing (when assisted),
  command issuance, and authorization;
- an assisted command carries the exact case assessment and valid signed
  assessment;
- a human-direct sequence-zero command is allowed after viewing the case;
- after a journal action, only an exact signed/adjudicated observed outcome may
  be linked, and it must match `POINT_AWARDED` or `REPLAY_NO_POINT`;
- `NO_DECISION`, `CASE_INVALID`, and `ESCALATE` heads cannot link a score event;
- one case cannot link twice and one event cannot link to two cases.

The committed `CaseAuthorizationLink`, its fingerprint, the exact outbox ID,
and the context fingerprint are included in the outbox payload and ledger hash
chain. Post-write replay checks all event, case, journal, link, projection,
idempotency, and outbox rows before commit.

## SQLite source tables and projections

The schema will contain at least:

- `copilot_cases`: canonical signed case, immutable identity, current-head and
  linked-state projections;
- `copilot_journal`: canonical signed actions plus a per-match hash-chain
  position and exact archive verification generation;
- `copilot_authorization_links`: canonical one-to-one context/event link;
- existing authorization, event, state, idempotency, archive, and shadow-outbox
  tables.

Case and journal rows are append-only source records. Projection fields may be
updated only by fixed store code and must equal full replay. No delete, replace,
upsert, purge, compatibility, or arbitrary transaction-callback API exists.

The match projection and external `LedgerCheckpoint` additionally bind a
per-match review-history head and counts, so rolling back an unresolved or
unlinked review is detectable even when the score revision did not change.

## Fixed bounds

Before schema freeze, tests must pin conservative constants for:

- cases per match;
- review actions and total review records per match;
- canonical case, action, and link bytes;
- cumulative review bytes per match;
- clip count, object size, and total verified clip bytes per case;
- SQLite rows and aggregate envelope/archive bytes replayed per match;
- accepted clock skew and maximum action age, if the deployment clock contract
  permits either.

All count and aggregate-byte checks occur before fetching BLOBs. Replay streams
bounded rows rather than materializing the complete history.

## Required adversarial tests

- unsigned-head signer substitution;
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
- oversized row, count, aggregate-byte, depth, duplicate-key, and SQLite
  corruption inputs.

Only after those tests pass may the review UI or ScoreCheck shadow adapter treat
the database as a trusted audit source.
