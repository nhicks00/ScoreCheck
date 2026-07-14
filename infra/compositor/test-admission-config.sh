#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="$SCRIPT_DIR/egress.yaml"

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

capacity="$(awk -v max="$max_utilization" -v cpus="$host_vcpus" 'BEGIN { printf "%.1f", max * cpus }')"
printf 'PASS: c-4 admission is one web egress (capacity=%s cores, cost=%s cores)\n' \
  "$capacity" "$web_cpu_cost"
