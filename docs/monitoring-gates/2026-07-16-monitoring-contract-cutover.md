# Monitoring Contract Hard Cutover

Date: 2026-07-16

Classification: **PASS for the Pushover-only production contract and staged
deployment path. Operator-visible Pushover acknowledgement and Healthchecks
withheld-ping gates remain pending.**

## Bound revisions

- Production web: `39a6c0ffd6d764728a09463b6cc47b9412b66529`
- Production monitor service:
  `8fe05bde76b85446dbe03bbf8218ecba2eb52a4c`
- Monitor-service start:
  `2026-07-16T01:11:25.306298746Z`
- Notification contract: Pushover only; no Twilio or SMS runtime fields

## First staged attempt and rollback

The first service-only attempt used web/monitor contract revision `39a6c0ff`.
Docker created the candidate at `01:01:17Z`, started it at `01:01:18Z`, and
marked it healthy at `01:01:24Z` with restart count zero. Prometheus had sampled
the expected replacement interval as `up=0` from `01:01:22Z` through
`01:01:31Z`. The old deploy script queried `up` once during that interval and
therefore rejected a healthy candidate. Automatic rollback began at
`01:01:27Z`; the previous service was healthy again at `01:01:32Z`.

This was a deployment-validator race, not a service crash. No rules,
Alertmanager routing, Caddy configuration, media service, event state, output,
incident, or fault gate was changed. The old service remained the exact clean
rollback baseline.

## Hard-cut fix

Revision `8fe05bde` replaces the one-shot assertion with a bounded wait for one
successful `up{job="monitor-service"}` sample whose Prometheus sample timestamp
is at or after the candidate cutover epoch. This rejects a stale pre-cutover
`1`, tolerates the normal replacement scrape gap, and still fails closed after
60 seconds. The existing exact-revision, zero-restart, public-health, static
container identity, rules, and automatic rollback gates remain intact.

Validation before deployment:

- monitoring Vitest: 27 files, 147 tests;
- monitoring Node fault-evidence suites: 30 tests;
- strict TypeScript typecheck: pass;
- production service build: pass;
- Bash syntax and diff checks: pass.

## Live verification

The retry completed without rollback. At the post-cutover audit:

- `monitor-service` was healthy, exact revision `8fe05bde`, restart count zero;
- Prometheus, Alertmanager, Caddy, and node-exporter retained their container
  identities and remained running;
- Prometheus reported 8/8 active targets up, zero dropped targets, and 49/49
  healthy rules;
- Alertmanager reported zero alerts;
- the collector reported six of six agents fresh and healthy;
- active incidents, fault gates, and event were empty;
- Pushover was configured and healthy, with no Twilio/SMS contract member;
- the baseline Healthchecks sender was running, the coverage-aware sender was
  idle-paused, and Pushover remained attached to both checks;
- Camera 1 raw remained ready at approximately 6.1 Mbps with zero frame errors;
- Cameras 2-8 remained expected off; and
- no active Program reader or Egress existed.

The production dashboard continued serving exact web build `39a6c0ff`. The
validator fix is deployment-only, so another Vercel rollout was neither needed
nor performed.

## Remaining gates

No phone-visible test was sent during this cutover. The runbook still requires
the exact operator timing approval `READY FOR PUSHOVER GATE` before:

1. acknowledging an emergency Pushover notification from the phone; and
2. withholding one Healthchecks ping long enough to prove one phone alert and
   one recovery without duplicates.

Those operator interactions and the remaining real fault matrix are not
converted into passes by this release evidence.
