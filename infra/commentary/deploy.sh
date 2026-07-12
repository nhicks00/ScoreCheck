#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_HOST="${LIVEKIT_COMMENTARY_SSH_HOST:-root@138.197.194.146}"
SSH_KEY="${LIVEKIT_COMMENTARY_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${LIVEKIT_COMMENTARY_REMOTE_DIR:-/opt/livekit}"

: "${LIVEKIT_COMMENTARY_API_KEY:?LIVEKIT_COMMENTARY_API_KEY is required}"
: "${LIVEKIT_COMMENTARY_API_SECRET:?LIVEKIT_COMMENTARY_API_SECRET is required}"
export LIVEKIT_COMMENTARY_PUBLIC_IP="${LIVEKIT_COMMENTARY_PUBLIC_IP:-${SSH_HOST#*@}}"

node "$SCRIPT_DIR/render-config.mjs"

ssh -i "$SSH_KEY" "$SSH_HOST" "mkdir -p '$REMOTE_DIR/.incoming' '$REMOTE_DIR/caddy_data'"
rsync -a -e "ssh -i $SSH_KEY" \
  "$SCRIPT_DIR/docker-compose.yml" \
  "$SCRIPT_DIR/redis.conf" \
  "$SCRIPT_DIR/.generated/livekit.yaml" \
  "$SCRIPT_DIR/.generated/caddy.yaml" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"

ssh -i "$SSH_KEY" "$SSH_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p backups
for file in docker-compose.yaml livekit.yaml caddy.yaml redis.conf; do
  if [[ -f "$file" ]]; then cp "$file" "backups/$file.$timestamp"; fi
done

install -m 0644 .incoming/docker-compose.yml docker-compose.yaml
install -m 0600 .incoming/livekit.yaml livekit.yaml
install -m 0644 .incoming/caddy.yaml caddy.yaml
install -m 0644 .incoming/redis.conf redis.conf
/usr/local/bin/docker-compose -f docker-compose.yaml config -q
/usr/local/bin/docker-compose -f docker-compose.yaml pull --quiet
systemctl restart livekit-docker

for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:7880 >/dev/null \
    && curl -fsS http://127.0.0.1:6789/metrics >/dev/null; then
    echo "LiveKit commentary deployment healthy."
    exit 0
  fi
  sleep 1
done

journalctl -u livekit-docker --no-pager -n 120 >&2 || true
for file in docker-compose.yaml livekit.yaml caddy.yaml redis.conf; do
  backup="backups/$file.$timestamp"
  if [[ -f "$backup" ]]; then cp "$backup" "$file"; fi
done
systemctl restart livekit-docker || true
echo "LiveKit commentary health check failed; previous config restored." >&2
exit 1
REMOTE

curl -fsS --retry 12 --retry-delay 2 --max-time 5 \
  https://rtc.beachvolleyballmedia.com >/dev/null
echo "LiveKit commentary TLS endpoint healthy."
