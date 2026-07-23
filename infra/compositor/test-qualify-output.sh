#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/bin"
cp "$SCRIPT_DIR/qualify-output.sh" "$SCRIPT_DIR/lib.sh" "$FIXTURE/"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$FIXTURE/bin/flock"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$FIXTURE/bin/sleep"
ln -s "$(command -v jq)" "$FIXTURE/bin/jq"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'root="${MOCK_ROOT:?}"' \
  'if [[ "$*" == "restart bvm-redis" ]]; then' \
  '  exit 0' \
  'elif [[ "$*" == "restart bvm-livekit bvm-egress" ]]; then' \
  '  rm -f "$root/mock-active" "$root/list-count" "$root/output-path" "$root/current-attempt"' \
  'elif [[ "$*" == "inspect bvm-redis --format {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" || "$*" == "inspect bvm-egress --format {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" ]]; then' \
  '  printf '\''healthy\n'\''' \
  'elif [[ "$*" == "inspect bvm-livekit --format {{.State.Running}}" ]]; then' \
  '  printf '\''true\n'\''' \
  'else exit 2; fi' >"$FIXTURE/bin/docker"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'root="${MOCK_ROOT:?}"' \
  'state="$root/mock-active"' \
  'if [[ "$*" == "egress list --active --json" ]]; then' \
  '  if [[ -f "$state" ]]; then' \
  '    attempt="$(cat "$root/current-attempt")"' \
  '    id="EG_sample${attempt}"' \
  '    reads="$(( $(cat "$root/list-count") + 1 ))"' \
  '    printf '\''%s\n'\'' "$reads" >"$root/list-count"' \
  '    if (( attempt <= ${MOCK_STALL_ATTEMPTS:-0} || reads < 2 )); then' \
  '      printf '\''[{"egress_id":"%s","status":0}]'\'' "$id"' \
  '    else' \
  '      output="$(cat "$root/output-path")"' \
  '      mkdir -p "$(dirname "$output")"' \
  '      printf '\''fake-mp4'\'' >"$output"' \
  '      printf '\''[{"egress_id":"%s","status":1}]'\'' "$id"' \
  '    fi' \
  '  else printf '\''null'\''; fi' \
  'elif [[ "$*" == egress\ start\ --type\ web* ]]; then' \
  '  attempt="$(( $(cat "$root/start-count" 2>/dev/null || printf 0) + 1 ))"' \
  '  printf '\''%s\n'\'' "$attempt" >"$root/start-count"' \
  '  printf '\''%s\n'\'' "$attempt" >"$root/current-attempt"' \
  '  request="${@: -1}"' \
  '  cp "$request" "$root/captured-request.json"' \
  '  output="$(jq -r '\''.file_outputs[0].filepath'\'' "$request")"' \
  '  output="$root/evidence${output#/out}"' \
  '  printf '\''%s\n'\'' "$output" >"$root/output-path"' \
  '  printf '\''0\n'\'' >"$root/list-count"' \
  '  touch "$state"' \
  '  printf '\''EgressID: EG_sample%s Status: EGRESS_STARTING\n'\'' "$attempt"' \
  'elif [[ "$*" == egress\ stop\ --id\ EG_sample* ]]; then' \
  '  if [[ "${MOCK_STOP_STUCK:-0}" == 1 ]]; then exit 1; fi' \
  '  if [[ "${MOCK_STOP_STUCK_SUCCESS:-0}" == 1 ]]; then exit 0; fi' \
  '  rm -f "$state" "$root/list-count" "$root/output-path" "$root/current-attempt"' \
  'else' \
  '  exit 2' \
  'fi' >"$FIXTURE/bin/lk"
chmod 755 "$FIXTURE/bin/docker" "$FIXTURE/bin/flock" "$FIXTURE/bin/sleep" "$FIXTURE/bin/lk" "$FIXTURE/qualify-output.sh"

printf '%s\n' \
  'LIVEKIT_API_KEY=test-key' \
  'LIVEKIT_API_SECRET=test-secret' \
  'PROGRAM_PAGE_BASE_URL=https://scorecheck-abc123-test.vercel.app/program' \
  'PROGRAM_PAGE_TOKEN=test-program-token' \
  'PROGRAM_RENDERER_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'PROGRAM_RENDERER_DEPLOYMENT_ID=dpl_test123' \
  "MOCK_ROOT=$FIXTURE" >"$FIXTURE/.env"

PATH="$FIXTURE/bin:$PATH" "$FIXTURE/qualify-output.sh" 1 1080p30 00000000-0000-4000-8000-000000000001 >"$FIXTURE/report.json"
jq -e '.schemaVersion == 1 and .court == 1 and .profile == "1080p30" and .egressId == "EG_sample1" and .renderer.gitSha == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and .renderer.deploymentId == "dpl_test123" and .encoding == {width:1920,height:1080,framesPerSecond:30,audioCodec:"AAC",audioTargetBitrateKbps:128,audioSampleRateHz:48000,videoCodec:"H264_HIGH",videoTargetBitrateKbps:10000,keyFrameIntervalSeconds:2} and .startup.startAttempts == 1 and .startup.recoveredStartingStall == false and .startup.attempts[0].outcome == "ACTIVE" and .sizeBytes == 8' "$FIXTURE/report.json" >/dev/null
test ! -e "$FIXTURE/mock-active"
grep -Fq '"video_codec": "H264_HIGH"' "$FIXTURE/captured-request.json"
grep -Fq '"video_bitrate": 10000' "$FIXTURE/captured-request.json"
grep -Fq '"key_frame_interval": 2' "$FIXTURE/captured-request.json"
grep -Fq '"file_outputs"' "$FIXTURE/captured-request.json"
if grep -Fq 'stream_outputs' "$FIXTURE/captured-request.json"; then
  printf 'FAIL: conformance capture can publish a stream output\n' >&2
  exit 1
fi
test -f "$FIXTURE/evidence/00000000-0000-4000-8000-000000000001/court-1-1080p30.mp4"
MODE="$(stat -c '%a' "$FIXTURE/evidence/00000000-0000-4000-8000-000000000001" 2>/dev/null || stat -f '%Lp' "$FIXTURE/evidence/00000000-0000-4000-8000-000000000001")"
test "$MODE" = 770

# A completed capture is adopted without starting a second Egress.
PATH="$FIXTURE/bin:$PATH" "$FIXTURE/qualify-output.sh" 1 1080p30 00000000-0000-4000-8000-000000000001 >"$FIXTURE/adopted.json"
cmp "$FIXTURE/report.json" "$FIXTURE/adopted.json"

# One STARTING timeout is stopped to proven idle and retried exactly once.
rm -f "$FIXTURE/start-count"
MOCK_STALL_ATTEMPTS=1 PATH="$FIXTURE/bin:$PATH" "$FIXTURE/qualify-output.sh" 1 1080p30 00000000-0000-4000-8000-000000000002 >"$FIXTURE/recovered.json" 2>"$FIXTURE/recovered.err"
jq -e '.egressId == "EG_sample2" and .startup.startAttempts == 2 and .startup.recoveredStartingStall == true and [.startup.attempts[].outcome] == ["STARTING_TIMEOUT", "ACTIVE"]' "$FIXTURE/recovered.json" >/dev/null
grep -Fq 'remained STARTING; stopping the exact job before retry' "$FIXTURE/recovered.err"
test ! -e "$FIXTURE/mock-active"
test "$(cat "$FIXTURE/start-count")" = 2

# A second STARTING timeout fails closed after stopping the exact second job.
rm -f "$FIXTURE/start-count"
if MOCK_STALL_ATTEMPTS=2 PATH="$FIXTURE/bin:$PATH" "$FIXTURE/qualify-output.sh" 1 1080p30 00000000-0000-4000-8000-000000000003 >"$FIXTURE/stalled.json" 2>"$FIXTURE/stalled.err"; then
  printf 'FAIL: a second output-conformance STARTING timeout was accepted\n' >&2
  exit 1
fi
grep -Fq 'remained STARTING on both bounded attempts' "$FIXTURE/stalled.err"
test ! -e "$FIXTURE/mock-active"
test "$(cat "$FIXTURE/start-count")" = 2

# Cleanup must recover the exact ownerless job but keep qualification failed.
rm -f "$FIXTURE/start-count"
if MOCK_STALL_ATTEMPTS=1 MOCK_STOP_STUCK=1 PATH="$FIXTURE/bin:$PATH" "$FIXTURE/qualify-output.sh" 1 1080p30 00000000-0000-4000-8000-000000000004 >"$FIXTURE/cleanup-blocked.json" 2>"$FIXTURE/cleanup-blocked.err"; then
  printf 'FAIL: a stuck conformance Egress cleanup was accepted\n' >&2
  exit 1
fi
grep -Fq 'cleanup recovered but qualification is invalid' "$FIXTURE/cleanup-blocked.err"
grep -Fq 'isolated Egress control stack restarted' "$FIXTURE/cleanup-blocked.err"
test ! -e "$FIXTURE/mock-active"

# A successful stop response that never reaches idle uses the same bounded cleanup.
rm -f "$FIXTURE/start-count"
if MOCK_STALL_ATTEMPTS=1 MOCK_STOP_STUCK_SUCCESS=1 PATH="$FIXTURE/bin:$PATH" "$FIXTURE/qualify-output.sh" 1 1080p30 00000000-0000-4000-8000-000000000005 >"$FIXTURE/cleanup-not-idle.json" 2>"$FIXTURE/cleanup-not-idle.err"; then
  printf 'FAIL: a successful stop response with an active job was accepted\n' >&2
  exit 1
fi
grep -Fq 'cleanup recovered but qualification is invalid' "$FIXTURE/cleanup-not-idle.err"
grep -Fq 'isolated Egress control stack restarted' "$FIXTURE/cleanup-not-idle.err"
test ! -e "$FIXTURE/mock-active"

printf 'PASS: local-only output conformance capture is bounded, retry-safe, and idempotent\n'
