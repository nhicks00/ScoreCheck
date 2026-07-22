#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${COMPOSITOR_SSH_HOST:?COMPOSITOR_SSH_HOST is required}"
SSH_KEY="${COMPOSITOR_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${COMPOSITOR_REMOTE_DIR:-/opt/compositor}"
ENV_FILE="${COMPOSITOR_ENV_FILE:?COMPOSITOR_ENV_FILE is required}"
INGEST_PRIVATE_IP="${COMPOSITOR_INGEST_PRIVATE_IP:?COMPOSITOR_INGEST_PRIVATE_IP is required}"
INGEST_HOST="${COMPOSITOR_INGEST_HOST:?COMPOSITOR_INGEST_HOST is required}"
KNOWN_HOSTS="${SCORECHECK_SSH_KNOWN_HOSTS:?SCORECHECK_SSH_KNOWN_HOSTS is required}"

[[ "$INGEST_PRIVATE_IP" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]] \
  || { echo "error: COMPOSITOR_INGEST_PRIVATE_IP must be a private IPv4 address" >&2; exit 1; }
[[ "$INGEST_HOST" =~ ^[a-z0-9.-]+$ && "$INGEST_HOST" == *.* ]] \
  || { echo "error: COMPOSITOR_INGEST_HOST must be a DNS hostname" >&2; exit 1; }

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
  "$SCRIPT_DIR/normalize-camera.sh" \
  "$SCRIPT_DIR/qualify-output.sh" \
  "$SCRIPT_DIR/rebind-ingest.sh" \
  "$SCRIPT_DIR/start-court.sh" \
  "$SCRIPT_DIR/start-normalizer.sh" \
  "$SCRIPT_DIR/stop-normalizer.sh" \
  "$SCRIPT_DIR/stop-court.sh" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"
rsync -a -e "$rsync_shell" "$ENV_FILE" "$SSH_HOST:$REMOTE_DIR/.incoming/.env"

ssh "${ssh_options[@]}" "$SSH_HOST" "REMOTE_DIR='$REMOTE_DIR' MEDIAMTX_PRIVATE_HOST='$INGEST_PRIVATE_IP' MEDIAMTX_PUBLIC_HOST='$INGEST_HOST' bash -s" <<'REMOTE'
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
had_previous=0
if [[ -f docker-compose.yml && -f .env ]]; then
  mkdir -p backups
  backup_files=(docker-compose.yml livekit.yaml egress.yaml headless_shell
    chrome-sandboxing-seccomp-profile.json lib.sh list-egress.sh
    qualify-output.sh start-court.sh stop-court.sh .env)
  for optional in normalize-camera.sh rebind-ingest.sh start-normalizer.sh stop-normalizer.sh; do
    [[ -f "$optional" ]] && backup_files+=("$optional")
  done
  tar -czf "backups/compositor-$timestamp.tar.gz" "${backup_files[@]}"
  had_previous=1
fi

for file in docker-compose.yml livekit.yaml egress.yaml chrome-sandboxing-seccomp-profile.json; do
  install -m 0644 ".incoming/$file" "$file"
done
for file in headless_shell lib.sh list-egress.sh normalize-camera.sh qualify-output.sh rebind-ingest.sh start-court.sh start-normalizer.sh stop-normalizer.sh stop-court.sh; do
  install -m 0755 ".incoming/$file" "$file"
done
install -d -m 0700 evidence
install -d -m 0755 /var/lib/scorecheck-monitoring/ffmpeg
install -m 0600 .incoming/.env .env
if grep -Eq '^MEDIAMTX_(PRIVATE_HOST|PUBLIC_HOST)=' .env; then
  echo "Compositor source environment unexpectedly owns an ingest network binding." >&2
  exit 1
fi
printf 'MEDIAMTX_PRIVATE_HOST="%s"\n' "$MEDIAMTX_PRIVATE_HOST" >>.env
printf 'MEDIAMTX_PUBLIC_HOST="%s"\n' "$MEDIAMTX_PUBLIC_HOST" >>.env
docker compose config -q
retry_docker_operation docker compose pull --quiet
retry_docker_operation docker compose --profile hevc-normalizer pull --quiet normalizer
docker compose --profile hevc-normalizer rm -sf normalizer >/dev/null 2>&1 || true

if ! docker compose up -d --remove-orphans; then
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
