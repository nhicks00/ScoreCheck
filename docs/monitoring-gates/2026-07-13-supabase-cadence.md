# Supabase Score-Polling Cadence Gate

## Scope

This gate verified the post-soak persistence hard cutover without activating a
public event. A uniquely named inactive fixture polled a stable authoritative
VolleyballLife result at the production 1.8-second cadence. It had no public
media destination and was deleted after each run.

## Defect Found

The first measured preflight failed because `score_states.updated_at` advanced
on an unchanged score. PostgreSQL `jsonb` returned set-score object keys in a
canonical order, while the API-derived objects retained insertion order. The
poller compared both with `JSON.stringify`, treated the equivalent values as
different, and rewrote `score_states` and `overlay_states` on every source poll.

The hard-cutover fix replaced order-sensitive object serialization with
recursive JSON-value equality. Object key order is ignored; array order and
all scalar values remain significant. Regression coverage proves reordered
keys compare equal while an actual point difference does not.

## Accepted Run

Measured window: 2026-07-14 03:08:40Z through 03:38:46Z
(2026-07-13 22:08:40 through 22:38:46 America/Chicago).

| Check | Baseline | Final | Result |
| --- | ---: | ---: | --- |
| Elapsed | 0 | 1,805.632 seconds | Pass |
| Source polls | 0 | 997 | Pass |
| Poll errors | 0 | 0 | Pass |
| `score_states.n_tup_upd` | 2,825,132 | 2,825,132 | No growth |
| `overlay_states.n_tup_upd` | 1,838,415 | 1,838,415 | No growth |
| Source-heartbeat updates | 21 | 187 | +166, bounded |
| Lease updates | 1,883,774 | 1,883,886 | +112, bounded |
| Worker-heartbeat updates | 607,394 | 607,564 | +170, bounded |
| Realtime daily inserts | 4 | 4 | No growth |
| Realtime daily relation | 40,960 bytes | 40,960 bytes | No growth |

The semantic score, `score_states.updated_at`, `overlay_states.updated_at`,
court state, and match state were identical at baseline and final. Source,
worker, and lease freshness remained within their gates. The Realtime
publication remained limited to `chat_messages`, `court_flags`, and
`scorer_sessions`; neither `score_states` nor `score_source_heartbeats` was
published.

Cleanup passed after the final snapshot. No cadence-gate event or worker
heartbeat remained.

## Boundary

This result accepts unchanged-state persistence cadence and Realtime isolation.
It does not replace live point-transition tests, the real-camera pacing
comparator, reader churn, camera reconnect, normalization capacity, or the
direct-eight venue gate.
