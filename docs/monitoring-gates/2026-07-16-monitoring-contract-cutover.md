# Monitoring Contract Hard Cutover

Date: 2026-07-16

Classification: **PASS for the Pushover-only production contract, staged
deployment path, operator acknowledgement, and both external Healthchecks
withheld-ping gates.**

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

## Operator-visible phone gates

Nathan supplied the exact `READY FOR PUSHOVER GATE` approval before any
provider-visible test. Three bounded checks then passed without changing media,
event state, or output:

1. The baseline Healthchecks sender was withheld at
   `2026-07-16T01:32:52.750Z`. The provider entered grace, became down after the
   expected alert boundary, returned up after pings resumed, and produced one
   phone alert plus one recovery.
2. A direct emergency Pushover was submitted at `01:48:54Z` and acknowledged
   from the phone at `01:48:57Z`. The recovery message was accepted once.
3. The coverage-aware Healthchecks sender was withheld at
   `01:49:34.100Z`, became down at `01:51:37Z`, recovered after pings resumed,
   and returned to its correct idle-paused state by `01:53:13Z`.

The final monitor snapshot had no event, incident, or fault gate; baseline was
running, active was paused, and the single Healthchecks Pushover integration
was attached to both checks. Protected evidence is stored under the three
timestamped `~/.config/scorecheck/fault-evidence` directories. Provider receipt
identifiers and credentials are intentionally omitted from this report.

## Stable endpoint cutover

After every camera publisher was confirmed off and Nathan reported
`ROUTER ONLINE`, the retained ingest and commentary Reserved IPv4s were attached
to the exact existing Droplet IDs. `preview`, `rtc`, and `turn` were updated and
both Cloudflare and Google resolvers converged. The venue router was then
rebound from the ordinary ingest address to the retained ingest anchor through
the protected `rebind-ingest-anchor.sh` transaction.

Final verification at `2026-07-16T02:13:11.696Z` proved a fresh WireGuard
handshake, four new and zero old policy rules, two new and zero old firewall
rules, both RTMP and SRT route lookups through `connectify0` table `900`, zero
camera flows, Speedify `CONNECTED`, runtime `CONNECTED_ROUTED`, and exactly one
watchdog process. Public ingest health, RTMP, LiveKit HTTPS, and TURN/TLS passed;
the monitor remained healthy with 6/6 fresh agents and all eight cameras
expected off. The protected router backup and provider/DNS rollback record are
retained with the completed cutover evidence.

These gates close the phone-provider and persistent-endpoint prerequisites.
They do not convert the remaining real fault matrix or eight-output endurance
gate into passes.
