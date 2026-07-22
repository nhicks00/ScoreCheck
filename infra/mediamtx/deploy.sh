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
: "${MEDIAMTX_CONTENT_ANALYZER_BINDINGS:?MEDIAMTX_CONTENT_ANALYZER_BINDINGS is required}"
export MEDIAMTX_PUBLIC_IP="${MEDIAMTX_PUBLIC_IP:-${SSH_HOST#*@}}"

node "$SCRIPT_DIR/render-config.mjs"

ssh_options=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
rsync_shell="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"

ssh "${ssh_options[@]}" "$SSH_HOST" "mkdir -p '$REMOTE_DIR/.incoming' '$REMOTE_DIR/fonts' && install -d -m 0755 /var/lib/scorecheck-monitoring/ffmpeg"
rsync -a -e "$rsync_shell" \
  "$SCRIPT_DIR/docker-compose.yml" "$SCRIPT_DIR/scorecheck-ffmpeg-runner.sh" "$SCRIPT_DIR/scorecheck-preview-runner.sh" "$GENERATED" "$GENERATED_CADDY" \
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
compose_changed=1
caddy_changed=1
installed_files=(docker-compose.yml mediamtx.yml Caddyfile scorecheck-ffmpeg-runner.sh scorecheck-preview-runner.sh)
existing_files=0
for path in "${installed_files[@]}"; do
  [[ -f "$path" ]] && existing_files=$((existing_files + 1))
done
if [[ "$existing_files" -ne 0 && "$existing_files" -ne "${#installed_files[@]}" ]]; then
  echo "MediaMTX deployment directory contains an incomplete rollback baseline." >&2
  exit 1
fi
if [[ "$existing_files" -eq "${#installed_files[@]}" ]]; then
  cp docker-compose.yml "backups/docker-compose.$timestamp.yml"
  cp mediamtx.yml "backups/mediamtx.$timestamp.yml"
  cp Caddyfile "backups/Caddyfile.$timestamp"
  cp scorecheck-ffmpeg-runner.sh "backups/scorecheck-ffmpeg-runner.$timestamp.sh"
  cp scorecheck-preview-runner.sh "backups/scorecheck-preview-runner.$timestamp.sh"
  cmp -s docker-compose.yml .incoming/docker-compose.yml && compose_changed=0
  cmp -s Caddyfile .incoming/Caddyfile && caddy_changed=0
  had_previous=1
fi

restore_previous() {
  cp "backups/docker-compose.$timestamp.yml" docker-compose.yml
  cp "backups/mediamtx.$timestamp.yml" mediamtx.yml
  cp "backups/Caddyfile.$timestamp" Caddyfile
  cp "backups/scorecheck-ffmpeg-runner.$timestamp.sh" scorecheck-ffmpeg-runner.sh
  cp "backups/scorecheck-preview-runner.$timestamp.sh" scorecheck-preview-runner.sh
}

install -m 0644 .incoming/docker-compose.yml docker-compose.yml
install -m 0600 .incoming/mediamtx.yml mediamtx.yml
install -m 0644 .incoming/Caddyfile Caddyfile
install -m 0755 .incoming/scorecheck-ffmpeg-runner.sh scorecheck-ffmpeg-runner.sh
install -m 0755 .incoming/scorecheck-preview-runner.sh scorecheck-preview-runner.sh
if ! docker compose config -q; then
  if [[ "$had_previous" -eq 1 ]]; then restore_previous; fi
  echo "MediaMTX candidate Compose configuration is invalid." >&2
  exit 1
fi

services=(mediamtx)
if [[ "$had_previous" -eq 0 || "$compose_changed" -eq 1 || "$caddy_changed" -eq 1 ]]; then
  services+=(caddy)
fi
caddy_before="$(docker inspect bvm-mediamtx-caddy --format '{{.Id}}' 2>/dev/null || true)"
if [[ "$had_previous" -eq 1 && -z "$caddy_before" ]]; then
  restore_previous
  echo "Existing Caddy container must be running before a bounded MediaMTX deployment." >&2
  exit 1
fi

retry_docker_operation docker compose pull --quiet "${services[@]}"
if ! docker compose up -d --force-recreate "${services[@]}"; then
  if [[ "$had_previous" -eq 1 ]]; then
    restore_previous
    docker compose up -d --force-recreate "${services[@]}"
  else
    docker compose down --remove-orphans || true
  fi
  exit 1
fi

for attempt in $(seq 1 30); do
  if docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null | grep -qx true \
    && docker inspect bvm-mediamtx-caddy --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null | grep -qx healthy \
    && curl -fsS http://127.0.0.1:9997/v3/config/global/get >/dev/null; then
    if [[ "$had_previous" -eq 1 && "$compose_changed" -eq 0 && "$caddy_changed" -eq 0 ]]; then
      caddy_after="$(docker inspect bvm-mediamtx-caddy --format '{{.Id}}' 2>/dev/null || true)"
      if [[ "$caddy_after" != "$caddy_before" ]]; then
        echo "Caddy identity changed during a MediaMTX-only deployment." >&2
        break
      fi
    fi
    echo "MediaMTX deployment healthy."
    exit 0
  fi
  sleep 1
done

docker logs --tail=100 mediamtx >&2 || true
if [[ "$had_previous" -eq 1 ]]; then
  restore_previous
  docker compose up -d --force-recreate "${services[@]}"
  echo "MediaMTX health check failed; previous config restored." >&2
else
  docker compose down --remove-orphans || true
  echo "MediaMTX first deployment failed and was stopped." >&2
fi
exit 1
REMOTE

if ! curl -fsS --retry 60 --retry-all-errors --retry-delay 5 --retry-max-time 300 \
  --connect-timeout 5 --max-time 10 "https://$MEDIAMTX_PUBLIC_HOST/healthz" >/dev/null; then
  echo "MediaMTX public TLS endpoint did not become healthy within 300 seconds." >&2
  ssh "${ssh_options[@]}" "$SSH_HOST" \
    "cd '$REMOTE_DIR' && docker compose logs --tail=120 caddy" >&2 || true
  exit 1
fi
echo "MediaMTX public TLS endpoint healthy."
