#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/bin" "$FIXTURE/mock" "$FIXTURE/state" "$FIXTURE/export"
cp "$SCRIPT_DIR/egress-supervisor.sh" "$SCRIPT_DIR/start-court.sh" "$SCRIPT_DIR/stop-court.sh" "$SCRIPT_DIR/lib.sh" "$FIXTURE/"
printf 'services: {}\n' >"$FIXTURE/docker-compose.yml"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$FIXTURE/bin/flock"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$FIXTURE/bin/sleep"
ln -s "$(command -v jq)" "$FIXTURE/bin/jq"
ln -s "$(command -v openssl)" "$FIXTURE/bin/openssl"

cat >"$FIXTURE/bin/lk" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "egress list --active --json" ]]; then
  cat "$MOCK_DIR/active.json"
elif [[ "$*" == egress\ start\ --type\ web* ]]; then
  count="$(cat "$MOCK_DIR/start-count")"
  count=$((count + 1))
  printf '%s\n' "$count" >"$MOCK_DIR/start-count"
  id="EG_test${count}"
  printf '[{"egress_id":"%s"}]\n' "$id" >"$MOCK_DIR/active.json"
  printf 'EgressID: %s Status: EGRESS_STARTING\n' "$id"
elif [[ "$1 $2 $3" == "egress stop --id" ]]; then
  if [[ -e "$MOCK_DIR/stop-fail" ]]; then
    exit 1
  fi
  printf 'null\n' >"$MOCK_DIR/active.json"
else
  exit 2
fi
MOCK

cat >"$FIXTURE/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == inspect && "$4" == *'.Id'* ]]; then
  cat "$MOCK_DIR/container-id"
elif [[ "$1" == inspect && "$4" == *Health* ]]; then
  printf 'healthy\n'
elif [[ "$1" == compose ]]; then
  count="$(cat "$MOCK_DIR/recreate-count")"
  count=$((count + 1))
  printf '%s\n' "$count" >"$MOCK_DIR/recreate-count"
  [[ ! -e "$MOCK_DIR/recreate-fail" ]] || exit 1
  printf 'container-%s\n' "$count" >"$MOCK_DIR/container-id"
else
  exit 2
fi
MOCK

cat >"$FIXTURE/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'/metrics'* ]]; then
  if [[ -f "$MOCK_DIR/metrics" ]]; then
    cat "$MOCK_DIR/metrics"
  else
    cat <<'METRICS'
livekit_egress_available{node_id="test"} 1
livekit_egress_can_accept_request{node_id="test"} 1
livekit_load_ratio{node_id="test",type="pulse"} 0.05
METRICS
  fi
elif [[ "$*" == *'/api/program/renderer-binding'* ]]; then
  if [[ -e "$MOCK_DIR/renderer-mismatch" ]]; then
    git_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  else
    git_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  fi
  cat <<JSON
{"schemaVersion":1,"provider":"vercel","origin":"https://scorecheck-abc123-test.vercel.app","deploymentId":"dpl_test123","gitSha":"${git_sha}","assetNamespace":"dpl_test123","contracts":{"programSession":"program-session-v1","overlayState":"overlay-state-v1","commentary":"commentary-v1","browserHeartbeat":"browser-heartbeat-v6"}}
JSON
else
  printf 'ok\n'
fi
MOCK
chmod 755 "$FIXTURE/bin/flock" "$FIXTURE/bin/sleep" "$FIXTURE/bin/lk" "$FIXTURE/bin/docker" "$FIXTURE/bin/curl"

printf 'null\n' >"$FIXTURE/mock/active.json"
printf '0\n' >"$FIXTURE/mock/start-count"
printf '0\n' >"$FIXTURE/mock/recreate-count"
printf 'container-original\n' >"$FIXTURE/mock/container-id"
printf '%s\n' \
  "MOCK_DIR=$FIXTURE/mock" \
  'LIVEKIT_API_KEY=test-key' \
  'LIVEKIT_API_SECRET=test-secret-long-enough' \
  'PROGRAM_PAGE_BASE_URL=http://renderer:3000/program' \
  'PROGRAM_PAGE_TOKEN=test-program-token' \
  'PROGRAM_RENDERER_RELEASE_ORIGIN=https://scorecheck-abc123-test.vercel.app' \
  'PROGRAM_RENDERER_BUNDLE_SHA256=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  'PROGRAM_RENDERER_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'PROGRAM_RENDERER_DEPLOYMENT_ID=dpl_test123' \
  'COURT_1_YOUTUBE_KEY=test-stream-key' >"$FIXTURE/.env"

run_start() {
  PATH="$FIXTURE/bin:$PATH" "$FIXTURE/start-court.sh" 1 1080p30 event-test broadcast-test "$1" primary >/dev/null
}
run_once() {
  PATH="$FIXTURE/bin:$PATH" \
    SCORECHECK_EGRESS_SUPERVISOR_STATE_DIR="$FIXTURE/state" \
    SCORECHECK_EGRESS_SUPERVISOR_EXPORT_DIR="$FIXTURE/export" \
    "$FIXTURE/egress-supervisor.sh" once >/dev/null
}
assert_recycled_metrics_rejected() {
  local generation="$1" metrics="$2" start_count
  run_start "$generation"
  start_count="$(<"$FIXTURE/mock/start-count")"
  printf 'null\n' >"$FIXTURE/mock/active.json"
  printf '%s\n' "$metrics" >"$FIXTURE/mock/metrics"
  run_once
  run_once
  run_once
  jq -e '.status == "RECOVERY_FAILED" and .recoveryAttempts == 1' "$FIXTURE/state/state.json" >/dev/null
  grep -Fxq "$start_count" "$FIXTURE/mock/start-count"
  PATH="$FIXTURE/bin:$PATH" "$FIXTURE/stop-court.sh" 1 >/dev/null
  run_once
  jq -e '.status == "IDLE"' "$FIXTURE/state/state.json" >/dev/null
  rm "$FIXTURE/mock/metrics"
}

run_start generation-one
run_once
jq -e '.status == "HEALTHY" and .recoveryAttempts == 0' "$FIXTURE/state/state.json" >/dev/null
export_mode="$(stat -c '%a' "$FIXTURE/export/state.json" 2>/dev/null || stat -f '%Lp' "$FIXTURE/export/state.json")"
[[ "$export_mode" == "644" ]]
export_directory_mode="$(stat -c '%a' "$FIXTURE/export" 2>/dev/null || stat -f '%Lp' "$FIXTURE/export")"
[[ "$export_directory_mode" == "755" ]]

printf 'null\n' >"$FIXTURE/mock/active.json"
run_once
jq -e '.status == "MISSING_PENDING" and .missingCount == 1' "$FIXTURE/state/state.json" >/dev/null
run_once
jq -e '.status == "MISSING_PENDING" and .missingCount == 2' "$FIXTURE/state/state.json" >/dev/null
run_once
jq -e '.status == "RECOVERED" and .recoveryAttempts == 1 and .egressId == "EG_test2"' "$FIXTURE/state/state.json" >/dev/null
jq -e '.egressId == "EG_test2" and .outputGeneration == "generation-one"' "$FIXTURE/requests/court-1.owner.json" >/dev/null
jq -e '.schemaVersion == 3 and .rendererRuntimeOrigin == "http://renderer:3000" and .rendererBundleSha256 == "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$FIXTURE/requests/court-1.owner.json" >/dev/null
grep -Fxq 'EG_test2' "$FIXTURE/requests/court-1.egress-id"
grep -Fq 'EG_test2' "$FIXTURE/mock/active.json"
grep -Fxq '1' "$FIXTURE/mock/recreate-count"
run_once
grep -Fxq '1' "$FIXTURE/mock/recreate-count"

printf 'null\n' >"$FIXTURE/mock/active.json"
run_once
run_once
touch "$FIXTURE/mock/renderer-mismatch"
run_once
jq -e '.status == "CONTROL_UNAVAILABLE" and .recoveryAttempts == 1' "$FIXTURE/state/state.json" >/dev/null
grep -Fxq '1' "$FIXTURE/mock/recreate-count"
rm "$FIXTURE/mock/renderer-mismatch"
printf '[{"egress_id":"EG_test2"}]\n' >"$FIXTURE/mock/active.json"
run_once
jq -e '.status == "HEALTHY" and .missingCount == 0' "$FIXTURE/state/state.json" >/dev/null

printf '[{"egress_id":"EG_unowned"}]\n' >"$FIXTURE/mock/active.json"
run_once
jq -e '.status == "AMBIGUOUS_ACTIVE"' "$FIXTURE/state/state.json" >/dev/null
grep -Fxq '1' "$FIXTURE/mock/recreate-count"

printf '[{"egress_id":"EG_test2"}]\n' >"$FIXTURE/mock/active.json"
touch "$FIXTURE/mock/stop-fail"
if PATH="$FIXTURE/bin:$PATH" "$FIXTURE/stop-court.sh" 1 >/dev/null 2>&1; then
  printf 'FAIL: stop failure did not fail closed\n' >&2
  exit 1
fi
test -f "$FIXTURE/requests/court-1.stop-intent"
run_once
jq -e '.status == "STOP_INTENT"' "$FIXTURE/state/state.json" >/dev/null
grep -Fxq '1' "$FIXTURE/mock/recreate-count"
rm "$FIXTURE/mock/stop-fail"
PATH="$FIXTURE/bin:$PATH" "$FIXTURE/stop-court.sh" 1 >/dev/null
test ! -e "$FIXTURE/requests/court-1.owner.json"
test ! -e "$FIXTURE/requests/court-1.json"
test ! -e "$FIXTURE/requests/court-1.stop-intent"
run_once
jq -e '.status == "IDLE"' "$FIXTURE/state/state.json" >/dev/null

assert_recycled_metrics_rejected generation-nonfinite $'livekit_egress_available{node_id="test"} 1\nlivekit_egress_can_accept_request{node_id="test"} 1\nlivekit_load_ratio{node_id="test",type="pulse"} NaN'
assert_recycled_metrics_rejected generation-duplicate $'livekit_egress_available{node_id="test"} 1\nlivekit_egress_can_accept_request{node_id="test"} 1\nlivekit_load_ratio{node_id="test",type="pulse"} 0.05\nlivekit_load_ratio{node_id="other",type="pulse"} 0.06'
assert_recycled_metrics_rejected generation-negative $'livekit_egress_available{node_id="test"} 1\nlivekit_egress_can_accept_request{node_id="test"} 1\nlivekit_load_ratio{node_id="test",type="pulse"} -0.01'
assert_recycled_metrics_rejected generation-fractional-web $'livekit_egress_available{node_id="test"} 1\nlivekit_egress_can_accept_request{node_id="test"} 1\nlivekit_egress_requests{node_id="test",type="web"} 0.5\nlivekit_load_ratio{node_id="test",type="pulse"} 0.05'

run_start generation-two
printf 'null\n' >"$FIXTURE/mock/active.json"
touch "$FIXTURE/mock/recreate-fail"
run_once
run_once
run_once
jq -e '.status == "RECOVERY_FAILED" and .recoveryAttempts == 1' "$FIXTURE/state/state.json" >/dev/null
run_once
jq -e '.status == "RECOVERY_FAILED" and .recoveryAttempts == 2' "$FIXTURE/state/state.json" >/dev/null
run_once
jq -e '.status == "RECOVERY_EXHAUSTED" and .recoveryAttempts == 2' "$FIXTURE/state/state.json" >/dev/null

printf '[{"egress_id":"EG_other"}]\n' >"$FIXTURE/mock/active.json"
rm "$FIXTURE/mock/recreate-fail"
run_once
jq -e '.status == "AMBIGUOUS_ACTIVE" and .recoveryAttempts == 2' "$FIXTURE/state/state.json" >/dev/null

printf 'PASS: exact-owner Egress supervision is bounded and deliberate-stop safe\n'
