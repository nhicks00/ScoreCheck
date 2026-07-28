#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FFMPEG_RUNNER="$SCRIPT_DIR/../mediamtx/scorecheck-ffmpeg-runner.sh"
SSH_HOST="${COMPOSITOR_SSH_HOST:?COMPOSITOR_SSH_HOST is required}"
SSH_KEY="${COMPOSITOR_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${COMPOSITOR_REMOTE_DIR:-/opt/compositor}"
ENV_FILE="${COMPOSITOR_ENV_FILE:?COMPOSITOR_ENV_FILE is required}"
RENDERER_ENV_FILE="${COMPOSITOR_RENDERER_ENV_FILE:?COMPOSITOR_RENDERER_ENV_FILE is required}"
RENDERER_BUNDLE="${COMPOSITOR_RENDERER_BUNDLE:?COMPOSITOR_RENDERER_BUNDLE is required}"
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
[[ -f "$RENDERER_ENV_FILE" ]] || { echo "error: renderer environment file is missing" >&2; exit 1; }
[[ -f "$RENDERER_BUNDLE" ]] || { echo "error: renderer bundle is missing" >&2; exit 1; }
[[ -x "$FFMPEG_RUNNER" ]] || { echo "error: monitored FFmpeg runner is missing" >&2; exit 1; }
for protected_file in "$ENV_FILE" "$RENDERER_ENV_FILE" "$RENDERER_BUNDLE"; do
  permissions="$(stat -f '%Lp' "$protected_file" 2>/dev/null || stat -c '%a' "$protected_file")"
  (( (8#$permissions & 8#077) == 0 )) || { echo "error: compositor protected inputs must be mode 0600 or stricter" >&2; exit 1; }
done

ssh_options=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
rsync_shell="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"

ssh "${ssh_options[@]}" "$SSH_HOST" "mkdir -p '$REMOTE_DIR/.incoming'"
rsync -a --delete -e "$rsync_shell" \
  "$SCRIPT_DIR/docker-compose.yml" \
  "$SCRIPT_DIR/livekit.yaml" \
  "$SCRIPT_DIR/egress.yaml" \
  "$SCRIPT_DIR/scorecheck-egress-supervisor.service" \
  "$SCRIPT_DIR/headless_shell" \
  "$SCRIPT_DIR/chrome-sandboxing-seccomp-profile.json" \
  "$SCRIPT_DIR/lib.sh" \
  "$SCRIPT_DIR/list-egress.sh" \
  "$SCRIPT_DIR/egress-supervisor.sh" \
  "$SCRIPT_DIR/program-branch-warmer.sh" \
  "$SCRIPT_DIR/normalize-camera.sh" \
  "$FFMPEG_RUNNER" \
  "$SCRIPT_DIR/qualify-output.sh" \
  "$SCRIPT_DIR/rebind-ingest.sh" \
  "$SCRIPT_DIR/start-court.sh" \
  "$SCRIPT_DIR/start-normalizer.sh" \
  "$SCRIPT_DIR/stop-normalizer.sh" \
  "$SCRIPT_DIR/stop-court.sh" \
  "$SSH_HOST:$REMOTE_DIR/.incoming/"
rsync -a -e "$rsync_shell" "$ENV_FILE" "$SSH_HOST:$REMOTE_DIR/.incoming/.env"
rsync -a -e "$rsync_shell" "$RENDERER_ENV_FILE" "$SSH_HOST:$REMOTE_DIR/.incoming/renderer.env"
rsync -a -e "$rsync_shell" "$RENDERER_BUNDLE" "$SSH_HOST:$REMOTE_DIR/.incoming/local-renderer.tar.gz"

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
for command in jq sha256sum tar; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required on the compositor host" >&2; exit 1; }
done
expected_renderer_sha="$(sed -n 's/^PROGRAM_RENDERER_BUNDLE_SHA256="\([a-f0-9]\{64\}\)"$/\1/p' .incoming/.env)"
[[ "$expected_renderer_sha" =~ ^[a-f0-9]{64}$ ]] || { echo "Renderer bundle digest is absent from the compositor environment." >&2; exit 1; }
actual_renderer_sha="$(sha256sum .incoming/local-renderer.tar.gz | awk '{print $1}')"
[[ "$actual_renderer_sha" == "$expected_renderer_sha" ]] || { echo "Renderer bundle failed integrity verification." >&2; exit 1; }
renderer_stage=".renderer-$timestamp"
trap 'rm -rf "${renderer_stage:-}"' EXIT
rm -rf "$renderer_stage"
mkdir -m 0700 "$renderer_stage"
while IFS= read -r renderer_entry; do
  case "$renderer_entry" in
    /*|../*|*/../*|*/..) echo "Renderer bundle contains an unsafe path." >&2; exit 1 ;;
  esac
done < <(tar -tzf .incoming/local-renderer.tar.gz)
if tar -tvzf .incoming/local-renderer.tar.gz | awk 'substr($1,1,1) == "l" || substr($1,1,1) == "h" { found=1 } END { exit found ? 0 : 1 }'; then
  echo "Renderer bundle contains a symbolic or hard link." >&2
  exit 1
fi
tar -xzf .incoming/local-renderer.tar.gz -C "$renderer_stage"
[[ -f "$renderer_stage/server.js" && -f "$renderer_stage/scorecheck-renderer.json" ]] || { echo "Renderer bundle is incomplete." >&2; exit 1; }
renderer_git_sha="$(sed -n 's/^PROGRAM_RENDERER_GIT_SHA="\([a-f0-9]\{40\}\)"$/\1/p' .incoming/.env)"
renderer_deployment_id="$(sed -n 's/^PROGRAM_RENDERER_DEPLOYMENT_ID="\(dpl_[A-Za-z0-9]*\)"$/\1/p' .incoming/.env)"
jq -e --arg gitSha "$renderer_git_sha" --arg deploymentId "$renderer_deployment_id" \
  '.schemaVersion == 1 and .gitSha == $gitSha and .deploymentId == $deploymentId' \
  "$renderer_stage/scorecheck-renderer.json" >/dev/null \
  || { echo "Renderer artifact identity does not match the compositor environment." >&2; exit 1; }
if compgen -G 'requests/court-*.owner.json' >/dev/null; then
  echo "A compositor deployment cannot replace the renderer while an output owner exists." >&2
  exit 1
fi
had_previous=0
had_previous_supervisor_unit=0
supervisor_was_active=0
if systemctl is-active --quiet scorecheck-egress-supervisor.service 2>/dev/null; then
  supervisor_was_active=1
  systemctl stop scorecheck-egress-supervisor.service
fi
if [[ -f /etc/systemd/system/scorecheck-egress-supervisor.service ]]; then
  mkdir -p backups
  cp /etc/systemd/system/scorecheck-egress-supervisor.service "backups/scorecheck-egress-supervisor-$timestamp.service"
  had_previous_supervisor_unit=1
fi
if [[ -f docker-compose.yml && -f .env ]]; then
  mkdir -p backups
  backup_files=(docker-compose.yml livekit.yaml egress.yaml headless_shell
    chrome-sandboxing-seccomp-profile.json lib.sh list-egress.sh
    qualify-output.sh start-court.sh stop-court.sh .env)
  for optional in egress-supervisor.sh program-branch-warmer.sh normalize-camera.sh scorecheck-ffmpeg-runner.sh rebind-ingest.sh start-normalizer.sh stop-normalizer.sh; do
    [[ -f "$optional" ]] && backup_files+=("$optional")
  done
  for optional in renderer renderer.env renderer-cache local-renderer.tar.gz; do
    [[ -e "$optional" ]] && backup_files+=("$optional")
  done
  tar -czf "backups/compositor-$timestamp.tar.gz" "${backup_files[@]}"
  had_previous=1
fi

for file in docker-compose.yml livekit.yaml egress.yaml chrome-sandboxing-seccomp-profile.json; do
  install -m 0644 ".incoming/$file" "$file"
done
for file in headless_shell lib.sh list-egress.sh egress-supervisor.sh program-branch-warmer.sh normalize-camera.sh scorecheck-ffmpeg-runner.sh qualify-output.sh rebind-ingest.sh start-court.sh start-normalizer.sh stop-normalizer.sh stop-court.sh; do
  install -m 0755 ".incoming/$file" "$file"
done
install -d -m 0700 evidence
install -d -m 0700 requests
install -d -m 0700 renderer-cache
install -d -m 0755 /var/lib/scorecheck-monitoring/ffmpeg
install -d -m 0755 /var/lib/scorecheck-monitoring/program-warmer
install -m 0600 .incoming/.env .env
install -m 0600 .incoming/renderer.env renderer.env
install -m 0600 .incoming/local-renderer.tar.gz local-renderer.tar.gz
if grep -Eq '^MEDIAMTX_(PRIVATE_HOST|PUBLIC_HOST)=' .env; then
  echo "Compositor source environment unexpectedly owns an ingest network binding." >&2
  exit 1
fi
printf 'MEDIAMTX_PRIVATE_HOST="%s"\n' "$MEDIAMTX_PRIVATE_HOST" >>.env
printf 'MEDIAMTX_PUBLIC_HOST="%s"\n' "$MEDIAMTX_PUBLIC_HOST" >>.env
rm -rf renderer
mv "$renderer_stage" renderer
docker compose config -q
retry_docker_operation docker compose pull --quiet
retry_docker_operation docker compose --profile browser-normalizer pull --quiet normalizer
docker compose --profile browser-normalizer rm -sf normalizer >/dev/null 2>&1 || true

if ! docker compose up -d --remove-orphans --force-recreate renderer program-warmer \
  || ! docker compose up -d --remove-orphans; then
  if [[ "$had_previous" -eq 1 ]]; then
    rm -rf renderer renderer.env local-renderer.tar.gz
    tar -xzf "backups/compositor-$timestamp.tar.gz"
    docker compose up -d --remove-orphans || true
    if [[ "$supervisor_was_active" -eq 1 ]]; then
      systemctl start scorecheck-egress-supervisor.service || true
    fi
  else
    docker compose down --remove-orphans || true
    rm -rf renderer renderer.env local-renderer.tar.gz
  fi
  exit 1
fi

stack_healthy=0
for attempt in $(seq 1 120); do
  redis_status="$(docker inspect bvm-redis --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  renderer_status="$(docker inspect bvm-renderer --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  warmer_status="$(docker inspect bvm-program-warmer --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  egress_status="$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  livekit_running="$(docker inspect bvm-livekit --format '{{.State.Running}}' 2>/dev/null || true)"
  if [[ "$redis_status" == "healthy" && "$renderer_status" == "healthy" && "$warmer_status" == "healthy" && "$egress_status" == "healthy" && "$livekit_running" == "true" ]]; then
    curl -fsS http://127.0.0.1:3000/api/program/renderer-binding >/dev/null
    curl -fsS http://127.0.0.1:9091/ >/dev/null
    curl -fsS http://127.0.0.1:9090/metrics >/dev/null
    stack_healthy=1
    break
  fi
  sleep 2
done

if [[ "$stack_healthy" -ne 1 ]]; then
  docker compose ps >&2
  docker compose logs --tail=120 >&2 || true
  if [[ "$had_previous" -eq 1 ]]; then
    rm -rf renderer renderer.env local-renderer.tar.gz
    tar -xzf "backups/compositor-$timestamp.tar.gz"
    docker compose up -d --remove-orphans || true
    if [[ "$supervisor_was_active" -eq 1 ]]; then
      systemctl start scorecheck-egress-supervisor.service || true
    fi
    echo "Compositor health check failed; previous deployment restored." >&2
  else
    docker compose down --remove-orphans || true
    rm -rf renderer renderer.env local-renderer.tar.gz
    echo "Compositor first deployment failed and was stopped." >&2
  fi
  exit 1
fi

install -m 0644 .incoming/scorecheck-egress-supervisor.service /etc/systemd/system/scorecheck-egress-supervisor.service
systemctl daemon-reload
systemctl enable scorecheck-egress-supervisor.service >/dev/null
systemctl restart scorecheck-egress-supervisor.service
if ! systemctl is-active --quiet scorecheck-egress-supervisor.service; then
  systemctl status scorecheck-egress-supervisor.service --no-pager >&2 || true
  systemctl disable --now scorecheck-egress-supervisor.service >/dev/null 2>&1 || true
  if [[ "$had_previous" -eq 1 ]]; then
    rm -rf renderer renderer.env local-renderer.tar.gz
    tar -xzf "backups/compositor-$timestamp.tar.gz"
    docker compose up -d --remove-orphans || true
  else
    docker compose down --remove-orphans || true
    rm -rf renderer renderer.env local-renderer.tar.gz
  fi
  if [[ "$had_previous_supervisor_unit" -eq 1 ]]; then
    install -m 0644 "backups/scorecheck-egress-supervisor-$timestamp.service" /etc/systemd/system/scorecheck-egress-supervisor.service
    systemctl daemon-reload
    [[ "$supervisor_was_active" -eq 1 ]] && systemctl enable --now scorecheck-egress-supervisor.service >/dev/null 2>&1 || true
  else
    rm -f /etc/systemd/system/scorecheck-egress-supervisor.service
    systemctl daemon-reload
  fi
  echo "Egress supervisor failed to start." >&2
  exit 1
fi
echo "Compositor deployment healthy with exact-owner Egress supervision active."
REMOTE
