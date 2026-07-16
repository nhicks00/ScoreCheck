#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
SSH_HOST="${MONITOR_SSH_HOST:?MONITOR_SSH_HOST is required}"
SSH_KEY="${MONITOR_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
REMOTE_DIR="${MONITOR_REMOTE_DIR:-/opt/scorecheck-monitoring}"
KNOWN_HOSTS="${SCORECHECK_SSH_KNOWN_HOSTS:?SCORECHECK_SSH_KNOWN_HOSTS is required}"

for command in git node rsync ssh; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required deployment command is missing: $command." >&2
    exit 1
  fi
done

if [[ ! -r "$SSH_KEY" ]]; then
  echo "MONITOR_SSH_KEY is not readable." >&2
  exit 1
fi

if [[ ! "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || [[ "$REMOTE_DIR" == "/" || "$REMOTE_DIR" == *".."* || "$REMOTE_DIR" == *"//"* \
    || "$REMOTE_DIR" == *"/./"* || "$REMOTE_DIR" == *"/." || "$REMOTE_DIR" == */ ]]; then
  echo "MONITOR_REMOTE_DIR must be a normalized absolute path." >&2
  exit 1
fi

if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  echo "Refusing to deploy from a dirty worktree." >&2
  exit 1
fi

REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Unable to resolve an exact Git revision." >&2
  exit 1
fi

node "$SCRIPT_DIR/render-config.mjs"
node "$SCRIPT_DIR/render-service-env.mjs"

candidate_name="${REVISION:0:12}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
candidate_dir="$REMOTE_DIR/.incoming/$candidate_name"
ssh_options=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
rsync_shell="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"

cleanup_candidate() {
  ssh "${ssh_options[@]}" "$SSH_HOST" "rm -rf '$candidate_dir'" >/dev/null 2>&1 || true
}
trap cleanup_candidate EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

ssh "${ssh_options[@]}" "$SSH_HOST" "install -d -m 0700 '$candidate_dir/.generated'"
rsync -a --delete -e "$rsync_shell" "$SCRIPT_DIR/src/" "$SSH_HOST:$candidate_dir/src/"
rsync -a --delete -e "$rsync_shell" "$SCRIPT_DIR/rules/" "$SSH_HOST:$candidate_dir/rules/"
rsync -a -e "$rsync_shell" \
  "$SCRIPT_DIR/package.json" \
  "$SCRIPT_DIR/package-lock.json" \
  "$SCRIPT_DIR/tsconfig.json" \
  "$SCRIPT_DIR/test-alertmanager-inhibition.mjs" \
  "$SCRIPT_DIR/.dockerignore" \
  "$SCRIPT_DIR/Dockerfile" \
  "$SCRIPT_DIR/docker-compose.yml" \
  "$SCRIPT_DIR/Caddyfile" \
  "$SCRIPT_DIR/remote-provision.sh" \
  "$SCRIPT_DIR/remote-deploy.sh" \
  "$SSH_HOST:$candidate_dir/"
rsync -a -e "$rsync_shell" "$SCRIPT_DIR/.generated/service.env" "$SSH_HOST:$candidate_dir/.env"
rsync -a -e "$rsync_shell" \
  "$SCRIPT_DIR/.generated/prometheus.yml" \
  "$SCRIPT_DIR/.generated/alertmanager.yml" \
  "$SSH_HOST:$candidate_dir/.generated/"

deployment_mode="$(ssh "${ssh_options[@]}" "$SSH_HOST" "REMOTE_DIR='$REMOTE_DIR' bash -s" <<'REMOTE'
set -euo pipefail
required=(docker-compose.yml Caddyfile .env .generated/prometheus.yml .generated/alertmanager.yml rules src)
present=0
for path in "${required[@]}"; do
  [[ -e "$REMOTE_DIR/$path" ]] && present=$((present + 1))
done
if [[ "$present" -eq 0 ]]; then
  printf 'provision\n'
elif [[ "$present" -eq "${#required[@]}" ]]; then
  printf 'deploy\n'
else
  echo "Observability host has an incomplete live baseline." >&2
  exit 1
fi
REMOTE
)"

case "$deployment_mode" in
  provision) remote_entrypoint=remote-provision.sh ;;
  deploy) remote_entrypoint=remote-deploy.sh ;;
  *) echo "Unknown observability deployment mode." >&2; exit 1 ;;
esac
ssh "${ssh_options[@]}" "$SSH_HOST" \
  "REMOTE_DIR='$REMOTE_DIR' CANDIDATE_DIR='$candidate_dir' REVISION='$REVISION' bash '$candidate_dir/$remote_entrypoint'"

trap - EXIT INT TERM HUP
cleanup_candidate
