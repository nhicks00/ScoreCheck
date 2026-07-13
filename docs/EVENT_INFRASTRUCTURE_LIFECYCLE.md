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

The lifecycle tool uses exact event tags, exact droplet names, protected local
evidence, and a typed destruction confirmation.

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

The eventual `provision` command must build the entire corrected stack from a
single versioned manifest. It is intentionally not bound to the July seven-host
layout. The next capacity gate must first choose and validate:

- camera-side H.264 over SRT, which can avoid cloud video normalization, or
- a split normalization tier sized for the intended HEVC feeds; and
- compositor sizes that retain at least 20 percent sustained CPU headroom for
  two outputs, or one isolated compositor per output.

Once that decision passes eight simultaneous outputs, all provisioning scripts
and consumers move to the selected manifest in one hard cutover.
