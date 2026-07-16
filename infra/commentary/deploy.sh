#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${LIVEKIT_COMMENTARY_SSH_HOST:?LIVEKIT_COMMENTARY_SSH_HOST is required}"
SSH_KEY="${LIVEKIT_COMMENTARY_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${LIVEKIT_COMMENTARY_REMOTE_DIR:-/opt/livekit}"
KNOWN_HOSTS="${SCORECHECK_SSH_KNOWN_HOSTS:?SCORECHECK_SSH_KNOWN_HOSTS is required}"

: "${LIVEKIT_COMMENTARY_API_KEY:?LIVEKIT_COMMENTARY_API_KEY is required}"
: "${LIVEKIT_COMMENTARY_API_SECRET:?LIVEKIT_COMMENTARY_API_SECRET is required}"
: "${LIVEKIT_COMMENTARY_RTC_HOST:?LIVEKIT_COMMENTARY_RTC_HOST is required}"
: "${LIVEKIT_COMMENTARY_TURN_HOST:?LIVEKIT_COMMENTARY_TURN_HOST is required}"
export LIVEKIT_COMMENTARY_PUBLIC_IP="${LIVEKIT_COMMENTARY_PUBLIC_IP:-${SSH_HOST#*@}}"

node "$SCRIPT_DIR/render-config.mjs"

ssh_options=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
rsync_shell="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"

ssh "${ssh_options[@]}" "$SSH_HOST" "mkdir -p '$REMOTE_DIR/.incoming' '$REMOTE_DIR/caddy_data'"
rsync -a -e "$rsync_shell" \
  "$SCRIPT_DIR/docker-compose.yml" \
  "$SCRIPT_DIR/redis.conf" \
  "$SCRIPT_DIR/.generated/livekit.yaml" \
  "$SCRIPT_DIR/.generated/caddy.yaml" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"

ssh "${ssh_options[@]}" "$SSH_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
retry_docker_operation() {
  local attempt=1 delay_seconds=2 status
  while true; do
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if (( attempt >= 5 )); then
      return "$status"
    fi
    echo "Docker image acquisition failed (attempt $attempt/5); retrying in ${delay_seconds}s." >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
    delay_seconds=$((delay_seconds * 2))
  done
}
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
had_previous=0
for file in docker-compose.yaml livekit.yaml caddy.yaml redis.conf; do
  if [[ -f "$file" ]]; then cp "$file" "backups/$file.$timestamp"; fi
  [[ -f "$file" ]] && had_previous=1
done

install -m 0644 .incoming/docker-compose.yml docker-compose.yaml
install -m 0600 .incoming/livekit.yaml livekit.yaml
install -m 0644 .incoming/caddy.yaml caddy.yaml
install -m 0644 .incoming/redis.conf redis.conf
docker compose -f docker-compose.yaml config -q
retry_docker_operation docker compose -f docker-compose.yaml pull --quiet
docker compose -f docker-compose.yaml up -d --remove-orphans

for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:7880 >/dev/null \
    && curl -fsS http://127.0.0.1:6789/metrics >/dev/null; then
    echo "LiveKit commentary deployment healthy."
    exit 0
  fi
  sleep 1
done

docker compose -f docker-compose.yaml logs --tail=120 >&2 || true
if [[ "$had_previous" -eq 1 ]]; then
  for file in docker-compose.yaml livekit.yaml caddy.yaml redis.conf; do
    backup="backups/$file.$timestamp"
    if [[ -f "$backup" ]]; then cp "$backup" "$file"; fi
  done
  docker compose -f docker-compose.yaml up -d --remove-orphans || true
  echo "LiveKit commentary health check failed; previous config restored." >&2
else
  docker compose -f docker-compose.yaml down --remove-orphans || true
  echo "LiveKit commentary first deployment failed and was stopped." >&2
fi
exit 1
REMOTE

curl -fsS --retry 30 --retry-all-errors --retry-delay 2 --retry-max-time 120 \
  --connect-timeout 5 --max-time 10 \
  "https://$LIVEKIT_COMMENTARY_RTC_HOST" >/dev/null
echo "LiveKit commentary TLS endpoint healthy."
