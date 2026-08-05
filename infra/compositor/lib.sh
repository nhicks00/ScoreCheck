#!/usr/bin/env bash
# lib.sh — shared helpers for the court scripts (start-court.sh / stop-court.sh /
# list-egress.sh). Sourced, never executed directly.
#
# Provides:
#   load_env             source ./.env if present (exported for compose parity)
#   require_livekit_env  validate + export LIVEKIT_URL/API_KEY/API_SECRET for lk
#   find_lk              set $LK to the LiveKit CLI binary (lk, or livekit-cli)
#   wait_for_recycled_egress_worker
#                        require a new healthy, idle, PulseAudio-capable worker

# Directory this lib (and the scripts) live in — also where .env and requests/ go.
COMPOSITOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source ./.env with auto-export so values reach lk and generated requests.
# Note: values in .env overwrite same-named variables already in the shell.
load_env() {
  if [[ -f "$COMPOSITOR_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$COMPOSITOR_DIR/.env"
    set +a
  fi
}

# The lk CLI reads LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the
# environment; fail fast with a useful message if the keypair is missing.
require_livekit_env() {
  export LIVEKIT_URL="${LIVEKIT_URL:-http://127.0.0.1:7880}"
  if [[ -z "${LIVEKIT_API_KEY:-}" || -z "${LIVEKIT_API_SECRET:-}" ]]; then
    echo "error: LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set." >&2
    echo "  cp .env.example .env  # in $COMPOSITOR_DIR, then fill in the keypair" >&2
    echo "  (generate one: docker run --rm livekit/livekit-server generate-keys)" >&2
    exit 1
  fi
  export LIVEKIT_API_KEY LIVEKIT_API_SECRET
}

# Locate the LiveKit CLI. v2+ installs as `lk`; `livekit-cli` is the legacy name
# of the same binary. Install:
#   macOS:  brew install livekit-cli
#   Linux:  curl -sSL https://get.livekit.io/cli | bash
find_lk() {
  if command -v lk >/dev/null 2>&1; then
    LK=lk
  elif command -v livekit-cli >/dev/null 2>&1; then
    LK=livekit-cli
  else
    echo "error: LiveKit CLI not found on PATH." >&2
    echo "  macOS: brew install livekit-cli" >&2
    echo "  Linux: curl -sSL https://get.livekit.io/cli | bash" >&2
    exit 1
  fi
}

egress_idle_metrics_ready() {
  awk '
    function finite(value) {
      return value ~ /^[-+]?(([0-9]+([.][0-9]*)?)|([.][0-9]+))([eE][-+]?[0-9]+)?$/
    }
    /^livekit_egress_available[{ ]/ {
      available_count++
      if (!finite($NF)) invalid=1
      available=$NF + 0
    }
    /^livekit_egress_can_accept_request[{ ]/ {
      accept_count++
      if (!finite($NF)) invalid=1
      accept=$NF + 0
    }
    /^livekit_egress_requests[{].*type="web"/ {
      web_count++
      if ($NF !~ /^[0-9]+$/) invalid=1
      web=$NF + 0
    }
    /^livekit_load_ratio[{].*type="pulse"/ {
      pulse_count++
      if (!finite($NF)) invalid=1
      pulse=$NF + 0
    }
    END {
      if (invalid || available_count != 1 || accept_count != 1 || pulse_count != 1 || web_count > 1) exit 1
      if (available != 1 || accept != 1 || (web_count == 1 && web != 0)) exit 1
      if (pulse < 0 || pulse >= 1) exit 1
    }
  '
}

wait_for_recycled_egress_worker() {
  local old_container_id="$1" maximum_attempts="${2:-120}" new_container_id="" health="" metrics="" attempt
  [[ "$maximum_attempts" =~ ^[1-9][0-9]*$ ]] || return 1
  for ((attempt = 0; attempt < maximum_attempts; attempt += 1)); do
    new_container_id="$(docker inspect bvm-egress --format '{{.Id}}' 2>/dev/null || true)"
    health="$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
    if [[ -n "$new_container_id" && "$new_container_id" != "$old_container_id" && "$health" == "healthy" ]] \
      && curl -fsS http://127.0.0.1:9091/ >/dev/null 2>&1; then
      metrics="$(curl -fsS http://127.0.0.1:9090/metrics 2>/dev/null || true)"
      if printf '%s\n' "$metrics" | egress_idle_metrics_ready; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}
