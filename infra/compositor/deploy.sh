#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${COMPOSITOR_SSH_HOST:?COMPOSITOR_SSH_HOST is required}"
SSH_KEY="${COMPOSITOR_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${COMPOSITOR_REMOTE_DIR:-/opt/compositor}"
ENV_FILE="${COMPOSITOR_ENV_FILE:?COMPOSITOR_ENV_FILE is required}"
KNOWN_HOSTS="${SCORECHECK_SSH_KNOWN_HOSTS:?SCORECHECK_SSH_KNOWN_HOSTS is required}"

for command in rsync ssh stat; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required" >&2; exit 1; }
done
[[ -r "$SSH_KEY" ]] || { echo "error: compositor SSH key is not readable" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "error: compositor environment file is missing" >&2; exit 1; }
permissions="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE")"
(( (8#$permissions & 8#077) == 0 )) || { echo "error: compositor environment file must be mode 0600 or stricter" >&2; exit 1; }

ssh_options=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
rsync_shell="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"

ssh "${ssh_options[@]}" "$SSH_HOST" "mkdir -p '$REMOTE_DIR/.incoming'"
rsync -a --delete -e "$rsync_shell" \
  "$SCRIPT_DIR/docker-compose.yml" \
  "$SCRIPT_DIR/livekit.yaml" \
  "$SCRIPT_DIR/egress.yaml" \
  "$SCRIPT_DIR/headless_shell" \
  "$SCRIPT_DIR/chrome-sandboxing-seccomp-profile.json" \
  "$SCRIPT_DIR/lib.sh" \
  "$SCRIPT_DIR/list-egress.sh" \
  "$SCRIPT_DIR/start-court.sh" \
  "$SCRIPT_DIR/stop-court.sh" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"
rsync -a -e "$rsync_shell" "$ENV_FILE" "$SSH_HOST:$REMOTE_DIR/.incoming/.env"

ssh "${ssh_options[@]}" "$SSH_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
had_previous=0
if [[ -f docker-compose.yml && -f .env ]]; then
  mkdir -p backups
  tar -czf "backups/compositor-$timestamp.tar.gz" \
    docker-compose.yml livekit.yaml egress.yaml headless_shell \
    chrome-sandboxing-seccomp-profile.json lib.sh list-egress.sh \
    start-court.sh stop-court.sh .env
  had_previous=1
fi

for file in docker-compose.yml livekit.yaml egress.yaml chrome-sandboxing-seccomp-profile.json; do
  install -m 0644 ".incoming/$file" "$file"
done
for file in headless_shell lib.sh list-egress.sh start-court.sh stop-court.sh; do
  install -m 0755 ".incoming/$file" "$file"
done
install -m 0600 .incoming/.env .env
docker compose config -q

if ! docker compose up -d --pull always --remove-orphans; then
  if [[ "$had_previous" -eq 1 ]]; then
    tar -xzf "backups/compositor-$timestamp.tar.gz"
    docker compose up -d --remove-orphans || true
  else
    docker compose down --remove-orphans || true
  fi
  exit 1
fi

for attempt in $(seq 1 120); do
  redis_status="$(docker inspect bvm-redis --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  egress_status="$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  livekit_running="$(docker inspect bvm-livekit --format '{{.State.Running}}' 2>/dev/null || true)"
  if [[ "$redis_status" == "healthy" && "$egress_status" == "healthy" && "$livekit_running" == "true" ]]; then
    curl -fsS http://127.0.0.1:9091/ >/dev/null
    curl -fsS http://127.0.0.1:9090/metrics >/dev/null
    echo "Compositor deployment healthy."
    exit 0
  fi
  sleep 2
done

docker compose ps >&2
docker compose logs --tail=120 >&2 || true
if [[ "$had_previous" -eq 1 ]]; then
  tar -xzf "backups/compositor-$timestamp.tar.gz"
  docker compose up -d --remove-orphans || true
  echo "Compositor health check failed; previous deployment restored." >&2
else
  docker compose down --remove-orphans || true
  echo "Compositor first deployment failed and was stopped." >&2
fi
exit 1
REMOTE
