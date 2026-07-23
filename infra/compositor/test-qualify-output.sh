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
  'state="$root/mock-active"' \
  'if [[ "$*" == "egress list --active --json" ]]; then' \
  '  if [[ -f "$state" ]]; then' \
  '    reads="$(( $(cat "$root/list-count") + 1 ))"' \
  '    printf '\''%s\n'\'' "$reads" >"$root/list-count"' \
  '    if (( reads < 2 )); then' \
  '      printf '\''[{"egress_id":"EG_sample","status":0}]'\''' \
  '    else' \
  '      output="$(cat "$root/output-path")"' \
  '      mkdir -p "$(dirname "$output")"' \
  '      printf '\''fake-mp4'\'' >"$output"' \
  '      printf '\''[{"egress_id":"EG_sample","status":1}]'\''' \
  '    fi' \
  '  else printf '\''null'\''; fi' \
  'elif [[ "$*" == egress\ start\ --type\ web* ]]; then' \
  '  request="${@: -1}"' \
  '  cp "$request" "$root/captured-request.json"' \
  '  output="$(jq -r '\''.file_outputs[0].filepath'\'' "$request")"' \
  '  output="$root/evidence${output#/out}"' \
  '  printf '\''%s\n'\'' "$output" >"$root/output-path"' \
  '  printf '\''0\n'\'' >"$root/list-count"' \
  '  touch "$state"' \
  '  printf '\''EgressID: EG_sample Status: EGRESS_STARTING\n'\''' \
  'elif [[ "$*" == "egress stop --id EG_sample" ]]; then' \
  '  rm -f "$state" "$root/list-count" "$root/output-path"' \
  'else' \
  '  exit 2' \
  'fi' >"$FIXTURE/bin/lk"
chmod 755 "$FIXTURE/bin/flock" "$FIXTURE/bin/sleep" "$FIXTURE/bin/lk" "$FIXTURE/qualify-output.sh"

printf '%s\n' \
  'LIVEKIT_API_KEY=test-key' \
  'LIVEKIT_API_SECRET=test-secret' \
  'PROGRAM_PAGE_BASE_URL=https://scorecheck-abc123-test.vercel.app/program' \
  'PROGRAM_PAGE_TOKEN=test-program-token' \
  'PROGRAM_RENDERER_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'PROGRAM_RENDERER_DEPLOYMENT_ID=dpl_test123' \
  "MOCK_ROOT=$FIXTURE" >"$FIXTURE/.env"

PATH="$FIXTURE/bin:$PATH" "$FIXTURE/qualify-output.sh" 1 1080p30 00000000-0000-4000-8000-000000000001 >"$FIXTURE/report.json"
jq -e '.schemaVersion == 1 and .court == 1 and .profile == "1080p30" and .egressId == "EG_sample" and .renderer.gitSha == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" and .renderer.deploymentId == "dpl_test123" and .encoding == {width:1920,height:1080,framesPerSecond:30,audioCodec:"AAC",audioTargetBitrateKbps:128,audioSampleRateHz:48000,videoCodec:"H264_HIGH",videoTargetBitrateKbps:10000,keyFrameIntervalSeconds:2} and .sizeBytes == 8' "$FIXTURE/report.json" >/dev/null
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

printf 'PASS: local-only output conformance capture is bounded and idempotent\n'
