#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

die() {
  echo "error: $*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

section() {
  printf '\n== %s ==\n' "$1"
}

for tool in bash git jq node npm rg; do
  require_tool "$tool"
done

cd "$REPO_ROOT"

[[ -f infra/monitoring/package-lock.json ]] || die "monitoring package lock is missing"
[[ -f apps/web/package-lock.json ]] || die "web package lock is missing"
jq -e '.schemaVersion == 1 and .desiredCompositors == 8 and .warmSpares == 1' \
  infra/event-stack/compositor-pool.json >/dev/null \
  || die "the checked-in compositor pool is not the reviewed eight-plus-one topology"

section "Repository integrity"
git diff --check

shell_scripts=()
while IFS= read -r shell_script; do
  shell_scripts+=("$shell_script")
done < <(rg --files infra | rg '\.sh$' | sort)
[[ "${#shell_scripts[@]}" -gt 0 ]] || die "no infrastructure shell scripts were found"
bash -n "${shell_scripts[@]}"

reviewed_shell_tests=(
  infra/compositor/test-admission-config.sh
  infra/compositor/test-start-court.sh
  infra/mediamtx/test-scorecheck-ffmpeg-runner.sh
  infra/venue-router/test-scorecheck-speedify-routing.sh
)
discovered_shell_tests="$(rg --files infra | rg '(^|/)(test[^/]*\.sh|[^/]*test\.sh)$' | sort)"
expected_shell_tests="$(printf '%s\n' "${reviewed_shell_tests[@]}" | sort)"
[[ "$discovered_shell_tests" == "$expected_shell_tests" ]] \
  || die "infrastructure shell-test inventory changed; review it and update this validator"

section "Capacity and lifecycle contracts"
node --test infra/event-stack/*.test.mjs infra/event-stack/rehearsal/*.test.mjs infra/capacity/*.test.mjs infra/commentary/*.test.mjs infra/mediamtx/*.test.mjs
node infra/event-stack/simulate-event-lifecycle.mjs
for test_script in "${reviewed_shell_tests[@]}"; do
  "$test_script"
done

section "Monitoring service"
npm --prefix infra/monitoring ci --ignore-scripts --no-audit --no-fund
npm --prefix infra/monitoring run typecheck
npm --prefix infra/monitoring test
npm --prefix infra/monitoring run build

section "Monitoring dashboard and web contracts"
npm --prefix apps/web ci --ignore-scripts --no-audit --no-fund
npm --prefix apps/web run typecheck
npm --prefix apps/web run lint
npm --prefix apps/web test
npm --prefix apps/web run build

section "Release validation passed"
printf 'Validated capacity, lifecycle, media runner, venue routing, monitoring service, and dashboard contracts.\n'
