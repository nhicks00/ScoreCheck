#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${MONITOR_AGENT_SSH_HOST:?MONITOR_AGENT_SSH_HOST is required}"
SSH_KEY="${MONITOR_AGENT_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${MONITOR_AGENT_REMOTE_DIR:-/opt/scorecheck-monitor-agent}"
KNOWN_HOSTS="${SCORECHECK_SSH_KNOWN_HOSTS:?SCORECHECK_SSH_KNOWN_HOSTS is required}"

: "${MONITOR_AGENT_ID:?MONITOR_AGENT_ID is required}"
: "${MONITOR_AGENT_ROLE:?MONITOR_AGENT_ROLE is required}"
: "${MONITOR_AGENT_TOKEN:?MONITOR_AGENT_TOKEN is required}"
: "${MONITOR_AGENT_BIND:?MONITOR_AGENT_BIND must be the host private address}"

node "$SCRIPT_DIR/render-agent-env.mjs"
GENERATED_ENV="$SCRIPT_DIR/.generated/agent-$MONITOR_AGENT_ID.env"
ssh_options=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
rsync_shell="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"

ssh "${ssh_options[@]}" "$SSH_HOST" "mkdir -p '$REMOTE_DIR/.incoming'"
rsync -a --delete -e "$rsync_shell" \
  "$SCRIPT_DIR/src" \
  "$SCRIPT_DIR/package.json" \
  "$SCRIPT_DIR/package-lock.json" \
  "$SCRIPT_DIR/tsconfig.json" \
  "$SCRIPT_DIR/Dockerfile" \
  "$SCRIPT_DIR/agent-compose.yml" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"
rsync -a -e "$rsync_shell" "$GENERATED_ENV" "$SSH_HOST:$REMOTE_DIR/.incoming/.env"

ssh "${ssh_options[@]}" "$SSH_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
mkdir -p /var/lib/scorecheck-monitoring/ffmpeg
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
elif [[ -x /usr/local/bin/docker-compose ]]; then
  compose() { /usr/local/bin/docker-compose "$@"; }
else
  echo "Docker Compose is not installed." >&2
  exit 1
fi
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -f agent-compose.yml ]]; then
  mkdir -p backups
  tar -czf "backups/agent-$timestamp.tar.gz" agent-compose.yml Dockerfile package.json package-lock.json tsconfig.json src .env 2>/dev/null || true
fi
rm -rf src
install -m 0644 .incoming/agent-compose.yml agent-compose.yml
install -m 0644 .incoming/Dockerfile Dockerfile
install -m 0644 .incoming/package.json package.json
install -m 0644 .incoming/package-lock.json package-lock.json
install -m 0644 .incoming/tsconfig.json tsconfig.json
install -m 0600 .incoming/.env .env
mv .incoming/src src
compose -f agent-compose.yml config -q
compose -f agent-compose.yml up -d --build --remove-orphans
for attempt in $(seq 1 60); do
  agent_container="$(compose -f agent-compose.yml ps -q monitor-agent 2>/dev/null || true)"
  if [[ -n "$agent_container" ]] \
    && docker inspect "$agent_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null | grep -qx healthy; then
    echo "ScoreCheck monitor agent healthy."
    exit 0
  fi
  sleep 2
done
compose -f agent-compose.yml ps >&2
compose -f agent-compose.yml logs --tail=100 monitor-agent >&2 || true
exit 1
REMOTE
