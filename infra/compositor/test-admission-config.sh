#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/egress.yaml"
COMPOSE="$SCRIPT_DIR/docker-compose.yml"
CHROME_LAUNCHER="$SCRIPT_DIR/headless_shell"
START_SCRIPT="$SCRIPT_DIR/start-court.sh"

read_scalar() {
  local key="$1"
  awk -v key="$key" '
    $1 == key ":" {
      print $2
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$CONFIG"
}

max_utilization="$(read_scalar max_cpu_utilization)"
web_cpu_cost="$(read_scalar web_cpu_cost)"
host_vcpus="${SCORECHECK_COMPOSITOR_VCPUS:-4}"

awk -v max="$max_utilization" -v cost="$web_cpu_cost" -v cpus="$host_vcpus" '
  BEGIN {
    capacity = max * cpus
    if (max <= 0 || max > 1) {
      print "FAIL: max_cpu_utilization must be in (0, 1]" > "/dev/stderr"
      exit 1
    }
    if (cost <= 0) {
      print "FAIL: web_cpu_cost must be positive" > "/dev/stderr"
      exit 1
    }
    if (cost > capacity) {
      print "FAIL: one web egress would be rejected" > "/dev/stderr"
      exit 1
    }
    if ((2 * cost) <= capacity) {
      print "FAIL: two web egresses would be admitted on the c-4 baseline" > "/dev/stderr"
      exit 1
    }
  }
'

chrome_shm_override="$(awk '
  /^chrome_flags:/ { in_chrome_flags = 1; next }
  in_chrome_flags && /^[^[:space:]]/ { in_chrome_flags = 0 }
  in_chrome_flags && $1 == "disable-dev-shm-usage:" { print $2; found = 1; exit }
  END { if (!found) exit 1 }
' "$CONFIG")"
[ "$chrome_shm_override" = "false" ] || {
  printf 'FAIL: disable-dev-shm-usage must be overridden to false\n' >&2
  exit 1
}
[ -x "$CHROME_LAUNCHER" ] || {
  printf 'FAIL: direct Chrome launcher must be executable\n' >&2
  exit 1
}
grep -Fq 'exec /opt/google/chrome/chrome "$@"' "$CHROME_LAUNCHER" || {
  printf 'FAIL: direct Chrome launcher must bypass the Google wrapper\n' >&2
  exit 1
}
grep -Fq './headless_shell:/usr/local/bin/headless_shell:ro' "$COMPOSE" || {
  printf 'FAIL: direct Chrome launcher must be mounted into the Egress container\n' >&2
  exit 1
}
grep -Fq 'test: ["CMD", "curl", "-fsS", "http://127.0.0.1:9091/"]' "$COMPOSE" || {
  printf 'FAIL: Egress healthcheck must use directly attributable exec form\n' >&2
  exit 1
}
if grep -Fq 'test: ["CMD-SHELL"' "$COMPOSE"; then
  printf 'FAIL: shell-form healthchecks are forbidden in the compositor stack\n' >&2
  exit 1
fi
grep -Fq 'flock -n 9' "$START_SCRIPT" || {
  printf 'FAIL: court starts must use the serialized admission lock\n' >&2
  exit 1
}
grep -Fq 'egress list --active --json' "$START_SCRIPT" || {
  printf 'FAIL: court starts must reject an existing active Egress\n' >&2
  exit 1
}
grep -Fq "jq -er" "$START_SCRIPT" || {
  printf 'FAIL: active Egress responses must be parsed as structured JSON\n' >&2
  exit 1
}

capacity="$(awk -v max="$max_utilization" -v cpus="$host_vcpus" 'BEGIN { printf "%.1f", max * cpus }')"
printf 'PASS: c-4 admission is one web egress (capacity=%s cores, cost=%s cores)\n' \
  "$capacity" "$web_cpu_cost"
