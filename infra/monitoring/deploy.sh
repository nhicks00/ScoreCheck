#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${MONITOR_SSH_HOST:?MONITOR_SSH_HOST is required}"
SSH_KEY="${MONITOR_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${MONITOR_REMOTE_DIR:-/opt/scorecheck-monitoring}"

node "$SCRIPT_DIR/render-config.mjs"
node "$SCRIPT_DIR/render-service-env.mjs"

ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$SSH_HOST" "mkdir -p '$REMOTE_DIR/.incoming'"
rsync -a --delete -e "ssh -i $SSH_KEY -o IdentitiesOnly=yes" \
  "$SCRIPT_DIR/src" \
  "$SCRIPT_DIR/rules" \
  "$SCRIPT_DIR/package.json" \
  "$SCRIPT_DIR/package-lock.json" \
  "$SCRIPT_DIR/tsconfig.json" \
  "$SCRIPT_DIR/Dockerfile" \
  "$SCRIPT_DIR/docker-compose.yml" \
  "$SCRIPT_DIR/Caddyfile" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"
rsync -a -e "ssh -i $SSH_KEY -o IdentitiesOnly=yes" \
  "$SCRIPT_DIR/.generated/prometheus.yml" \
  "$SCRIPT_DIR/.generated/alertmanager.yml" \
  "$SCRIPT_DIR/.generated/service.env" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"

ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$SSH_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose is not installed." >&2
  exit 1
fi
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -f docker-compose.yml ]]; then
  mkdir -p backups
  tar -czf "backups/monitoring-$timestamp.tar.gz" docker-compose.yml Dockerfile package.json package-lock.json tsconfig.json Caddyfile src rules .generated .env 2>/dev/null || true
fi
rm -rf src rules .generated
install -m 0644 .incoming/docker-compose.yml docker-compose.yml
install -m 0644 .incoming/Dockerfile Dockerfile
install -m 0644 .incoming/package.json package.json
install -m 0644 .incoming/package-lock.json package-lock.json
install -m 0644 .incoming/tsconfig.json tsconfig.json
install -m 0644 .incoming/Caddyfile Caddyfile
install -m 0600 .incoming/service.env .env
mkdir -m 0700 .generated
install -o 65534 -g 65534 -m 0400 .incoming/prometheus.yml .generated/prometheus.yml
install -o 65534 -g 65534 -m 0400 .incoming/alertmanager.yml .generated/alertmanager.yml
mv .incoming/src src
mv .incoming/rules rules
compose config -q
compose up -d --build --force-recreate --remove-orphans
for attempt in $(seq 1 90); do
  monitor_container="$(compose ps -q monitor-service 2>/dev/null || true)"
  if [[ -n "$monitor_container" ]] \
    && docker inspect "$monitor_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null | grep -qx healthy \
    && curl -fsS http://127.0.0.1:9090/-/ready >/dev/null \
    && curl -fsS http://127.0.0.1:9093/-/ready >/dev/null; then
    echo "ScoreCheck observability stack healthy."
    exit 0
  fi
  sleep 2
done
compose ps >&2
compose logs --tail=120 monitor-service prometheus alertmanager >&2 || true
exit 1
REMOTE
