# ScoreCheck Monitoring Infrastructure

This directory contains the browser-independent monitoring system described in
`docs/MONITORING_TELEMETRY_CONTRACT.md`.

## Processes

- `scorecheck-monitor-agent`: one read-only process per production host.
- `scorecheck-monitor-service`: independent collector, correlator, incident API,
  dead-man sender, notification dispatcher, and bounded history API.
- Prometheus: high-frequency metrics and primitive alert conditions.
- Alertmanager: grouping, inhibition, and delivery into the incident service.
- Caddy: the only public entry point, exposing the sanitized API over TLS.

The production controller is not in this collection path.

## Local verification

```bash
npm ci
npm run typecheck
npm test
```

Render protected Prometheus and Alertmanager configuration:

```bash
set -a
source .env
set +a
node render-config.mjs
node render-service-env.mjs
docker compose config -q
```

## Deploy a host agent

Set the values documented in `.env.example`, including the host private IP in
`MONITOR_AGENT_BIND`, then run:

```bash
MONITOR_AGENT_SSH_HOST=root@HOST ./deploy-agent.sh
```

The agent accesses Docker through a GET-only socket proxy. It never receives
the Docker socket directly and has no mutation endpoints.

Compositor agents must include `MONITOR_AGENT_COURTS`, for example `1,2`, and
the local Egress metrics/health URLs. The reusable registration flow deploys
the agent, updates the protected target set atomically, and can refresh the
central collector:

```bash
MONITOR_SSH_HOST=root@OBSERVABILITY_PUBLIC_IP \
  ../compositor/register-monitoring.sh \
  --name bvm-compositor-a \
  --ssh-host root@COMPOSITOR_PUBLIC_IP \
  --private-ip COMPOSITOR_VPC_IP \
  --courts 1,2 \
  --observability-private-ip OBSERVABILITY_VPC_IP \
  --refresh
```

`update-agent-target.mjs` never prints target credentials and atomically keeps
`~/.config/scorecheck/monitoring.env` mode `0600`.

## Provision and deploy observability

```bash
DIGITALOCEAN_TOKEN=... ./provision.sh --ssh-key REGISTERED_KEY_ID
```

After DNS points `MONITOR_PUBLIC_HOST` at the new host and cloud-init finishes:

```bash
MONITOR_SSH_HOST=root@HOST ./deploy.sh
```

Prometheus and Alertmanager bind only to host loopback. Caddy exposes only
`/healthz` and `/v1/*`; every non-health API requires its service credential.

## Expected-state lifecycle

Activating or completing an event initializes all court expectations to off.
A successful Production Console broadcast start arms a court for 18 hours:
media required, broadcast live, commentary optional, and scoring scheduled.
Observed live scoring promotes the effective state to `LIVE_MATCH`; a final
promotes it to `FINAL_HOLD`. Broadcast stop clears the expectation immediately.
This bounds idle polling/alerting without allowing an active court to remain
silently unmonitored.

## History

`GET /v1/range/court-pipeline` is the only initial range query. It uses fixed
PromQL and bounded window/step values; the browser cannot submit PromQL. The
admin dashboard requests a five-minute view every 30 seconds while visible.

## Incident operations

Acknowledgement stops repeated emergency delivery without hiding the incident.
The admin dashboard can also create an exact, durable 15-120 minute maintenance
silence. A silence suppresses paging only; health and incident evidence remain
visible. If the fault survives expiry, primary paging is re-armed before the SMS
escalation timer begins again.

The full event-day workflow, credential checklist, and fault gates are in
`docs/MONITORING_OPERATIONS_RUNBOOK.md`.

## Current gate

The infrastructure gate passes when MediaMTX, Commentary, and every assigned
compositor agent are scraped from the observability host, missing agents become
`UNKNOWN`, Alertmanager incidents are deduplicated, Egress capacity is visible,
and the external dead-man continues with all browsers closed.
