# Scoring Schema Hard Cutover 023-030

Date: 2026-07-22

Status: prepared, not applied

## Why this is a chain cutover

Production migration history was inspected before the poller-fencing release.
It contains `022_monitoring_incident_episodes` and the separately applied
`029_monitoring_pushover_only`, but it does not contain `023`, `024`, `026`,
`027`, `028`, or `030`. The live REST contract also lacks the community
scoring tables and RPCs created by `023-028`.

Migration `030_poller_lease_fencing.sql` calls
`community_commit_trusted_score`, which is installed by the missing community
scoring chain. Applying only `030` would therefore install an unusable provider
commit path and make the matching worker incompatible with production.

The only supported release is one bounded idle hard cutover of this exact
ordered set:

```text
023 community_witness_schema
024 community_witness_transactions
026 security_boundary_hardcut
027 canonical_current_set_command
028 community_media_sessions
030 poller_lease_fencing
```

Migration `029` must already be present and is not replayed. Do not use a broad
`supabase db push`, do not mark migrations applied without executing them, and
do not run old and new score workers concurrently.

## Destructive boundary

Migration `023` intentionally canonicalizes score state and removes the legacy
scorer session, claim, shadow-state, and session-event tables. The last
read-only production preflight found:

- 24 courts, 18 score rows, and 216 matches;
- 28 legacy scorer sessions, 33 claims, 28 shadow states, and 3,093 session
  events;
- no match assigned as current to multiple courts;
- no duplicate external match identity within an event;
- one score row without a match, one duplicate score row for a match, and three
  score rows for matches that were not current on a court.

The migration has deterministic handling for those score-row anomalies, but
the legacy history removal is irreversible without restoring the database
backup. Preserve a fresh physical backup plus exported row counts and hashes
before the cutover. After new scoring writes begin, prefer a forward repair;
do not attempt a hand-written partial rollback.

## Generator

`infra/event-stack/scoring-schema-cutover.mjs` reads the exact checked-in
migration files and generates SQL without connecting to Supabase. It refuses a
non-private output directory, an existing output, an active poller lease, a
partial target ledger, or target objects that exist without ledger rows. The
generated ledger rows retain each exact migration source as one statement.

Create a rollback-only rehearsal in a protected directory:

```bash
node infra/event-stack/scoring-schema-cutover.mjs rehearsal \
  --output /absolute/mode-0700/cutover-rehearsal.sql
```

The rehearsal applies all six migrations, verifies the tables/RPCs/role
boundary, proves current-generation commits and stale-generation rejection,
then rolls back schema, ledger, and fixture changes. Its final result must be:

```json
{"status":"PASS","mode":"rehearsal","rolledBack":true,"migrations":["023","024","026","027","028","030"]}
```

Only after that exact production-data rehearsal passes, generate the durable
transaction:

```bash
node infra/event-stack/scoring-schema-cutover.mjs apply \
  --output /absolute/mode-0700/cutover-apply.sql \
  --acknowledge APPLY_SCORING_SCHEMA_023_030
```

Generation is not execution. Submit each file through one authenticated
database session, preserve the generated SHA-256 and response, and never edit
the generated SQL by hand.

## Bounded execution order

1. Confirm no event, media workload, fault gate, or active score operation.
2. Record the exact production migration ledger and REST/RPC contract.
3. Verify a recent Supabase physical backup; export the affected legacy and
   canonical rows with counts and hashes.
4. Suspend the sole production score worker and wait until every poller lease
   is expired. Confirm its last heartbeat is idle.
5. Run the generated rehearsal. Require its rollback `PASS`, unchanged
   production ledger, and unchanged REST contract.
6. Generate the apply transaction from the same Git revision and verify its
   hash before submission.
7. Apply the transaction. Require the in-transaction contract and fixture to
   pass, then independently verify ledger versions, tables, RPCs, role grants,
   and `generation bigint` after commit.
8. Deploy the matching web and worker revision. Never restore the old worker
   against the migrated schema.
9. Verify one fresh generation-one lease, one fenced provider commit, stale
   generation rejection after ownership change, overlay repair, private
   Realtime, worker heartbeat, and no duplicate outbox publication.
10. Preserve deployment IDs, image/source revisions, restart counts, database
    evidence, and the guarded recovery decision before declaring the cutover
    complete.

## Recovery decision

If rehearsal fails, production is unchanged: keep the current worker and
investigate locally. If apply fails before commit, the transaction rolls back:
restore the old worker and verify the old contract. If commit succeeds but the
matching runtime cannot start, keep scoring writes stopped. Restore the
pre-cutover physical backup only when no post-cutover writes need preserving;
otherwise ship a forward fix. Never leave the old worker running against the
new schema.
