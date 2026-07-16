# Pushover-Only Schema Hard Cutover

Date: 2026-07-16

Classification: **PASS.** Production notification history is unchanged,
`incident_notifications.provider` now accepts only `pushover`, and migration
`029 / monitoring_pushover_only` is the sole migration-ledger addition.

## Safety boundary

The cutover ran while monitoring was idle. The preflight had no active event,
incident, or fault gate; all eight cameras were `EXPECTED_OFF`; and the
collector was `HEALTHY` with six of six agents fresh. No media, routing,
browser, Egress, YouTube, StreamRun, web, or Droplet action was performed.

Production's remote migration ledger ended at `022`. The cutover therefore did
not use `supabase db push`, did not replay or mark migrations `023` through
`028`, and did not promote the deferred vision proposal. It submitted exactly
`029_monitoring_pushover_only.sql` and one matching ledger row in a single
transaction through Supabase's authenticated database-query API.

## Before state

The final read-only preflight completed at `2026-07-16T17:15:41Z`:

- 31 notification rows existed and every provider was `pushover`;
- the provider constraint still allowed `pushover`, `twilio_sms`,
  `twilio_voice`, and `external`;
- ledger version `029` was absent; and
- the canonical notification-history SHA-256 was
  `30a3b896055df2ea980da3dc8e8d52bbbecfba945097e0a51f327fa09d9d901d`.

The protected before-state also captured the complete notification rows, the
sanitized monitor snapshot, and Docker inspection records for monitor-service,
Prometheus, Alertmanager, Caddy, and node-exporter.

## Transaction and verification

Supabase accepted the transaction at `2026-07-16T17:16:07Z`. The repository
verifier completed at `17:16:24Z`; its temporary-table probes accepted a
Pushover row, rejected a non-Pushover row with a check violation, and rolled
back all probe data. The read-only postflight at `17:16:25Z` then proved:

- provider counts remained exactly `pushover: 31`;
- non-Pushover history remained zero;
- the live constraint was exactly `CHECK ((provider = 'pushover'::text))`;
- the constraint comment was
  `ScoreCheck monitoring pages exclusively through Pushover.`; and
- ledger version `029` existed exactly once with name
  `monitoring_pushover_only`.

The ledger stores the complete migration SQL as one exact statement payload.
No runtime consumer depends on statement-array cardinality; version and name
are the deployed contract.

## Runtime preservation

The post-cutover monitor snapshot was generated at
`2026-07-16T17:16:38.134Z`. It remained `HEALTHY` with six of six agents fresh,
zero incidents, zero fault gates, no event, and all eight cameras
`EXPECTED_OFF`.

The canonical after-history SHA-256 was identical to the before hash. All five
observability containers retained their exact container IDs, remained running,
and kept restart count zero. `monitor-service` remained healthy. No service
restart was required because the deployed runtime was already Pushover-only.

Protected evidence is stored at
`~/.config/scorecheck/cutovers/pushover-only-schema-20260716T171130Z`. It
contains the exact requests and responses, before/after notification history,
monitor snapshots, container inspections, verifier input, and transaction SQL.
Credentials are not stored in the evidence bundle.

## Rollback status

The guarded rollback remains validated in disposable PostgreSQL and was not
executed in production. It restores the former provider constraint and removes
only the exact `029 / monitoring_pushover_only` ledger row; it does not delete
or rewrite notification history.

This closes the Pushover-only database-contract prerequisite. It does not close
the remaining one-court real-fault rows, the repeat freeze/black timing gate, or
the eight-court endurance and capacity gates.
