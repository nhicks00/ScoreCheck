#!/usr/bin/env bash
# Recreate an idle Egress worker and prove native admission before reuse.

set -euo pipefail
umask 077

# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

REQ_DIR="$COMPOSITOR_DIR/requests"
for command in awk curl docker flock jq; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "error: $command is required to recycle the Egress worker." >&2
    exit 1
  }
done

mkdir -p "$REQ_DIR"
chmod 700 "$REQ_DIR"
exec 9>"$REQ_DIR/start.lock"
flock 9

shopt -s nullglob
ownership_artifacts=(
  "$REQ_DIR"/court-*.owner.json
  "$REQ_DIR"/court-*.egress-id
  "$REQ_DIR"/court-*.json
  "$REQ_DIR"/court-*.stop-intent
)
shopt -u nullglob
if (( ${#ownership_artifacts[@]} != 0 )); then
  echo "error: refusing to recycle Egress while output ownership artifacts exist." >&2
  exit 1
fi

load_env
require_livekit_env
find_lk
active_file="$(mktemp "$REQ_DIR/.recycle-active.XXXXXX")"
trap 'rm -f "$active_file"' EXIT
if ! "$LK" egress list --active --json >"$active_file" 2>/dev/null \
  || ! jq -e '(. // []) | type == "array" and length == 0' "$active_file" >/dev/null; then
  echo "error: refusing to recycle Egress unless the active set is exactly empty." >&2
  exit 1
fi

old_container_id="$(docker inspect bvm-egress --format '{{.Id}}' 2>/dev/null || true)"
if ! docker compose -f "$COMPOSITOR_DIR/docker-compose.yml" --project-directory "$COMPOSITOR_DIR" up -d --force-recreate egress >/dev/null; then
  echo "error: Egress worker recreation failed." >&2
  exit 1
fi
if ! wait_for_recycled_egress_worker "$old_container_id"; then
  echo "error: recycled Egress worker did not become uniquely idle, admissible, and PulseAudio-capable." >&2
  exit 1
fi
echo "Egress worker recycled and admission-ready."
