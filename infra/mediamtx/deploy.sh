#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${MEDIAMTX_SSH_HOST:-root@206.189.169.162}"
SSH_KEY="${MEDIAMTX_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${MEDIAMTX_REMOTE_DIR:-/opt/mediamtx}"
GENERATED="$SCRIPT_DIR/.generated/mediamtx.yml"

: "${MEDIAMTX_PUBLISH_PASS:?MEDIAMTX_PUBLISH_PASS is required}"
export MEDIAMTX_PUBLIC_IP="${MEDIAMTX_PUBLIC_IP:-${SSH_HOST#*@}}"

node "$SCRIPT_DIR/render-config.mjs"

ssh -i "$SSH_KEY" "$SSH_HOST" "mkdir -p '$REMOTE_DIR/.incoming' '$REMOTE_DIR/fonts'"
rsync -a -e "ssh -i $SSH_KEY" \
  "$SCRIPT_DIR/docker-compose.yml" "$GENERATED" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"

ssh -i "$SSH_KEY" "$SSH_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
cp docker-compose.yml "backups/docker-compose.$timestamp.yml"
cp mediamtx.yml "backups/mediamtx.$timestamp.yml"

install -m 0644 .incoming/docker-compose.yml docker-compose.yml
install -m 0600 .incoming/mediamtx.yml mediamtx.yml
docker compose config -q

if ! docker compose up -d --force-recreate; then
  cp "backups/docker-compose.$timestamp.yml" docker-compose.yml
  cp "backups/mediamtx.$timestamp.yml" mediamtx.yml
  docker compose up -d --force-recreate
  exit 1
fi

for attempt in $(seq 1 30); do
  if docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null | grep -qx true \
    && curl -fsS http://127.0.0.1:9997/v3/config/global/get >/dev/null; then
    echo "MediaMTX deployment healthy."
    exit 0
  fi
  sleep 1
done

docker logs --tail=100 mediamtx >&2 || true
cp "backups/docker-compose.$timestamp.yml" docker-compose.yml
cp "backups/mediamtx.$timestamp.yml" mediamtx.yml
docker compose up -d --force-recreate
echo "MediaMTX health check failed; previous config restored." >&2
exit 1
REMOTE
