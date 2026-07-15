#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${MEDIAMTX_SSH_HOST:?MEDIAMTX_SSH_HOST is required}"
SSH_KEY="${MEDIAMTX_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${MEDIAMTX_REMOTE_DIR:-/opt/mediamtx}"
GENERATED="$SCRIPT_DIR/.generated/mediamtx.yml"
GENERATED_CADDY="$SCRIPT_DIR/.generated/Caddyfile"
KNOWN_HOSTS="${SCORECHECK_SSH_KNOWN_HOSTS:?SCORECHECK_SSH_KNOWN_HOSTS is required}"

for court in $(seq 1 8); do
  user_var="MEDIAMTX_COURT_${court}_PUBLISH_USER"
  pass_var="MEDIAMTX_COURT_${court}_PUBLISH_PASS"
  [[ -n "${!user_var:-}" ]] || { echo "error: $user_var is required" >&2; exit 1; }
  [[ -n "${!pass_var:-}" ]] || { echo "error: $pass_var is required" >&2; exit 1; }
done
: "${MEDIAMTX_PUBLIC_HOST:?MEDIAMTX_PUBLIC_HOST is required}"
export MEDIAMTX_PUBLIC_IP="${MEDIAMTX_PUBLIC_IP:-${SSH_HOST#*@}}"

node "$SCRIPT_DIR/render-config.mjs"

ssh_options=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
rsync_shell="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"

ssh "${ssh_options[@]}" "$SSH_HOST" "mkdir -p '$REMOTE_DIR/.incoming' '$REMOTE_DIR/fonts' /var/lib/scorecheck-monitoring/ffmpeg"
rsync -a -e "$rsync_shell" \
  "$SCRIPT_DIR/docker-compose.yml" "$SCRIPT_DIR/scorecheck-ffmpeg-runner.sh" "$GENERATED" "$GENERATED_CADDY" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"

ssh "${ssh_options[@]}" "$SSH_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
had_previous=0
if [[ -f docker-compose.yml && -f mediamtx.yml && -f Caddyfile ]]; then
  cp docker-compose.yml "backups/docker-compose.$timestamp.yml"
  cp mediamtx.yml "backups/mediamtx.$timestamp.yml"
  cp Caddyfile "backups/Caddyfile.$timestamp"
  had_previous=1
fi

install -m 0644 .incoming/docker-compose.yml docker-compose.yml
install -m 0600 .incoming/mediamtx.yml mediamtx.yml
install -m 0644 .incoming/Caddyfile Caddyfile
install -m 0755 .incoming/scorecheck-ffmpeg-runner.sh scorecheck-ffmpeg-runner.sh
docker compose config -q

if ! docker compose up -d --force-recreate; then
  if [[ "$had_previous" -eq 1 ]]; then
    cp "backups/docker-compose.$timestamp.yml" docker-compose.yml
    cp "backups/mediamtx.$timestamp.yml" mediamtx.yml
    docker compose up -d --force-recreate
  else
    docker compose down --remove-orphans || true
  fi
  exit 1
fi

for attempt in $(seq 1 30); do
  if docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null | grep -qx true \
    && docker inspect bvm-mediamtx-caddy --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null | grep -qx healthy \
    && curl -fsS http://127.0.0.1:9997/v3/config/global/get >/dev/null; then
    echo "MediaMTX deployment healthy."
    exit 0
  fi
  sleep 1
done

docker logs --tail=100 mediamtx >&2 || true
if [[ "$had_previous" -eq 1 ]]; then
  cp "backups/docker-compose.$timestamp.yml" docker-compose.yml
  cp "backups/mediamtx.$timestamp.yml" mediamtx.yml
  cp "backups/Caddyfile.$timestamp" Caddyfile
  docker compose up -d --force-recreate
  echo "MediaMTX health check failed; previous config restored." >&2
else
  docker compose down --remove-orphans || true
  echo "MediaMTX first deployment failed and was stopped." >&2
fi
exit 1
REMOTE

curl -fsS --retry 30 --retry-delay 2 --max-time 5 "https://$MEDIAMTX_PUBLIC_HOST/healthz" >/dev/null
echo "MediaMTX public TLS endpoint healthy."
