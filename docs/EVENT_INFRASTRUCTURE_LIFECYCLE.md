# Event Infrastructure Lifecycle

ScoreCheck production media servers are temporary event infrastructure. Vercel,
Supabase, GitHub, protected configuration, and retained evidence persist between
events; DigitalOcean media droplets do not.

## Operating window

1. T-24 hours: provision the versioned event stack, deploy configuration, and
   run camera, commentary, overlay, monitoring, and destination preflight.
2. Keep the complete stack running through the event.
3. T+2 to T+6 hours: end destinations, capture protected evidence, and verify
   the archive.
4. Explicitly destroy every droplet carrying the event tag. Powering a droplet
   off does not end billing.

There is no timer-based teardown. Tournament schedules move, so destruction
always requires an operator confirmation tied to the event slug and a completed
evidence bundle.

## Current cost baseline

The seven droplets used for the July 13 Gate 8 run cost $0.6875 per hour in
aggregate, or a $462 monthly equivalent:

| Window | Compute estimate |
| --- | ---: |
| 72 hours | $49.50 |
| 96 hours | $66.00 |
| 120 hours | $82.50 |
| 30-day equivalent | $462.00 |

These are live DigitalOcean size prices, not the final eight-court production
budget. Gate 8 invalidated the assumption that the current seven-droplet shape
can carry eight complete outputs: the ingest `c-4` cannot normalize eight
1080p inputs, and a compositor `c-4` does not retain safe headroom with two
current web-egress jobs. Do not automate that known-bad topology as the final
provision manifest.

## Lifecycle command

The lifecycle tool uses exact event tags, an exact manifest-to-inventory name
match, protected local evidence with integrity hashes, a destruction review
date, and a typed confirmation. After those checks it deletes the verified
droplet IDs individually; it never sends a tag-wide bulk deletion request.

```bash
cd infra/event-stack
source ../compositor/.env

./lifecycle.sh adopt --manifest gate8-2026-07-13.json --dry-run
./lifecycle.sh adopt --manifest gate8-2026-07-13.json
./lifecycle.sh inventory --manifest gate8-2026-07-13.json

./lifecycle.sh evidence \
  --manifest gate8-2026-07-13.json \
  --output ../../.local/event-evidence/gate8-2026-07-13

./lifecycle.sh destroy \
  --manifest gate8-2026-07-13.json \
  --evidence ../../.local/event-evidence/gate8-2026-07-13 \
  --confirm DESTROY:gate8-2026-07-13
```

The current Gate 8 stack must not be destroyed until the overnight soak is
finished and the operator explicitly confirms teardown.

## Cost controls

- Apply `scorecheck-event:<slug>`, `scorecheck-temporary`, and
  `scorecheck-destroy-after:<date>` tags to every temporary droplet.
- Use DigitalOcean's native billing alert for the account-level ceiling.
  DigitalOcean exposes one configured billing threshold, not three independent
  native thresholds. Implement lower $50/$75 warning levels in ScoreCheck
  observability if multiple stages are required.
- Check event-tag cost during every preflight and final evidence capture.
- Savings come from destroying event infrastructure after evidence capture,
  not from reducing production headroom.

## Provisioning hard cutover

The compositor portion of the corrected stack now has an exact versioned pool
specification at `infra/event-stack/compositor-pool.json`: one named `c-4` for
each Camera 1-8 assignment and one unassigned warm spare. The read-only capacity
preflight reconciles that specification against complete DigitalOcean inventory.
The compositor provisioner refuses to create an arbitrary name, a duplicate or
conflicting slot, a mismatched shape/court, an assigned warm spare, or any worker
while the account cannot fit the entire pool. A partially affordable pool is not
admitted as ready. The pool pins the base image and an account-level provisioning
lock serializes slot creation. A definite provider rejection releases the lock;
an ambiguous or incompletely verified create retains it so a retry cannot create
a same-name duplicate.

This does not make an event-specific manifest optional. New workers must still
be adopted into the exact event manifest and receive the event, temporary, and
destroy-after tags before event use. Other service roles remain bound to that
event manifest rather than the compositor pool specification.

The selected layout follows the capacity evidence:

- camera-side H.264 over SRT, which can avoid cloud video normalization, or
- a split normalization tier sized for the intended HEVC feeds; and
- compositor sizes that retain at least 20 percent sustained CPU headroom for
  two outputs, or one isolated compositor per output.

The one-output `c-4` decision has passed its isolated capacity gate. The full
pool still requires the DigitalOcean account limit to increase from ten to at
least twelve, followed by deployment and the direct-eight endurance gate; the
pool specification is readiness planning, not evidence that those workers exist
or that eight outputs have passed.
