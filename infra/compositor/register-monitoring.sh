#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MONITORING_DIR="$(cd "$SCRIPT_DIR/../monitoring" && pwd)"
SSH_KEY="${MONITOR_AGENT_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
NAME=""
SSH_HOST=""
PRIVATE_IP=""
COURTS=""
OBSERVABILITY_PRIVATE_IP=""
REFRESH=0

usage() {
  cat <<'USAGE'
Usage: register-monitoring.sh --name ID --ssh-host root@PUBLIC_IP \
  --private-ip VPC_IP --courts 1,2 --observability-private-ip VPC_IP [--refresh]

Deploys a read-only compositor monitor agent, atomically registers its private
target in the protected monitoring config, and optionally refreshes the central
observability stack. No production-control endpoint is added.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --ssh-host) SSH_HOST="$2"; shift 2 ;;
    --private-ip) PRIVATE_IP="$2"; shift 2 ;;
    --courts) COURTS="$2"; shift 2 ;;
    --observability-private-ip) OBSERVABILITY_PRIVATE_IP="$2"; shift 2 ;;
    --refresh) REFRESH=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option '$1'" >&2; usage >&2; exit 1 ;;
  esac
done

[[ "$NAME" =~ ^[a-zA-Z0-9_.:-]{1,80}$ ]] || { echo "error: invalid --name" >&2; exit 1; }
[[ -n "$SSH_HOST" ]] || { echo "error: --ssh-host is required" >&2; exit 1; }
[[ "$PRIVATE_IP" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "error: --private-ip must be a private VPC address" >&2; exit 1; }
[[ "$OBSERVABILITY_PRIVATE_IP" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "error: --observability-private-ip must be a private VPC address" >&2; exit 1; }
[[ "$COURTS" =~ ^[1-8](,[1-8])*$ ]] || { echo "error: --courts must be a comma-separated subset of 1-8" >&2; exit 1; }

CONFIG_FILE="${MONITOR_CONFIG_FILE:-$HOME/.config/scorecheck/monitoring.env}"
[[ -f "$CONFIG_FILE" ]] || { echo "error: protected monitoring config not found: $CONFIG_FILE" >&2; exit 1; }
set -a
source "$CONFIG_FILE"
set +a

TOKEN="$(node -e '
const id = process.argv[1];
const entry = (process.env.MONITOR_AGENT_TARGETS || "").split(",").find((value) => value.startsWith(`${id}|`));
if (entry) process.stdout.write(entry.split("|")[3] || "");
' "$NAME")"
if [[ -z "$TOKEN" ]]; then TOKEN="$(openssl rand -hex 32)"; fi

ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$SSH_HOST" \
  "ufw allow from '$OBSERVABILITY_PRIVATE_IP' to any port 9108 proto tcp >/dev/null 2>&1 || true"

MONITOR_AGENT_SSH_HOST="$SSH_HOST" \
MONITOR_AGENT_SSH_KEY="$SSH_KEY" \
MONITOR_AGENT_ID="$NAME" \
MONITOR_AGENT_ROLE=compositor \
MONITOR_AGENT_TOKEN="$TOKEN" \
MONITOR_AGENT_BIND="$PRIVATE_IP" \
MONITOR_AGENT_CONTAINERS=bvm-egress,bvm-livekit,bvm-redis \
MONITOR_AGENT_COURTS="$COURTS" \
EGRESS_METRICS_URL=http://127.0.0.1:9090/metrics \
EGRESS_HEALTH_URL=http://127.0.0.1:9091/ \
"$MONITORING_DIR/deploy-agent.sh"

MONITOR_CONFIG_FILE="$CONFIG_FILE" \
MONITOR_TARGET_ID="$NAME" \
MONITOR_TARGET_ROLE=compositor \
MONITOR_TARGET_URL="http://$PRIVATE_IP:9108" \
MONITOR_TARGET_TOKEN="$TOKEN" \
node "$MONITORING_DIR/update-agent-target.mjs"

if [[ "$REFRESH" -eq 1 ]]; then
  : "${MONITOR_SSH_HOST:?MONITOR_SSH_HOST is required with --refresh}"
  set -a
  source "$CONFIG_FILE"
  set +a
  MONITOR_SSH_HOST="$MONITOR_SSH_HOST" MONITOR_SSH_KEY="${MONITOR_SSH_KEY:-$SSH_KEY}" "$MONITORING_DIR/deploy.sh"
fi

unset TOKEN
echo "Compositor monitoring registration complete for $NAME (courts $COURTS)."
