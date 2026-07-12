# ScoreCheck Monitoring Infrastructure

This directory contains the browser-independent monitoring system described in
`docs/MONITORING_TELEMETRY_CONTRACT.md`.

## Processes

- `scorecheck-monitor-agent`: one read-only process per production host.
- `scorecheck-monitor-service`: independent collector, correlator, incident API,
  dead-man sender, and later notification dispatcher.
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

## Current gate

Phase 1 passes when agents on MediaMTX and LiveKit are scraped from the
observability host, missing agents become `UNKNOWN`, Alertmanager incidents are
deduplicated, and the external dead-man continues with all browsers closed.
