#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/bin"
cp "$SCRIPT_DIR/start-court.sh" "$SCRIPT_DIR/stop-court.sh" "$SCRIPT_DIR/lib.sh" "$FIXTURE/"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$FIXTURE/bin/flock"
ln -s "$(command -v jq)" "$FIXTURE/bin/jq"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "$*" == "egress list --active --json" ]]; then' \
  '  printf '\''Using protected LiveKit credentials\n'\'' >&2' \
  '  if [[ "${MOCK_ACTIVE:-0}" == 1 ]]; then printf '\''[{"egress_id":"EG_existing"}]'\''; else printf '\''null'\''; fi' \
  'elif [[ "$*" == egress\ start\ --type\ web* ]]; then' \
  '  printf '\''EgressID: EG_new Status: EGRESS_STARTING\n'\''' \
  'elif [[ "$*" == "egress stop --id EG_new" ]]; then' \
  '  exit 0' \
  'else' \
  '  exit 2' \
  'fi' >"$FIXTURE/bin/lk"
chmod 755 "$FIXTURE/bin/flock" "$FIXTURE/bin/lk" "$FIXTURE/start-court.sh" "$FIXTURE/stop-court.sh"

printf '%s\n' \
  'LIVEKIT_API_KEY=test-key' \
  'LIVEKIT_API_SECRET=test-secret-long-enough' \
  'PROGRAM_PAGE_BASE_URL=https://scorecheck-abc123-test.vercel.app/program' \
  'PROGRAM_PAGE_TOKEN=test-program-token' \
  'PROGRAM_RENDERER_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'PROGRAM_RENDERER_DEPLOYMENT_ID=dpl_test123' \
  'EGRESS_WIDTH=1280' \
  'EGRESS_HEIGHT=720' \
  'EGRESS_FRAMERATE=25' \
  'EGRESS_VIDEO_BITRATE=4000' \
  'EGRESS_AUDIO_BITRATE=64' \
  'EGRESS_AUDIO_FREQUENCY=44100' \
  'EGRESS_KEYFRAME_INTERVAL=4' \
  'COURT_1_YOUTUBE_KEY=test-stream-key' >"$FIXTURE/.env"

PATH="$FIXTURE/bin:$PATH" "$FIXTURE/start-court.sh" 1 1080p30 event-test broadcast-test generation-test >"$FIXTURE/start.out" 2>&1
grep -Fxq 'EG_new' "$FIXTURE/requests/court-1.egress-id"
jq -e '
  .schemaVersion == 1
  and .event == "event-test"
  and .court == 1
  and .destinationId == "broadcast-test"
  and .outputGeneration == "generation-test"
  and .outputProfile == "1080p30"
  and .rendererGitSha == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  and .rendererDeploymentId == "dpl_test123"
  and .egressId == "EG_new"
  and (.requestSha256 | test("^[a-f0-9]{64}$"))
' "$FIXTURE/requests/court-1.owner.json" >/dev/null
test ! -e "$FIXTURE/requests/court-1.start.log"
grep -Fq '"width": 1920' "$FIXTURE/requests/court-1.json"
grep -Fq '"height": 1080' "$FIXTURE/requests/court-1.json"
grep -Fq '"framerate": 30' "$FIXTURE/requests/court-1.json"
grep -Fq '"video_bitrate": 10000' "$FIXTURE/requests/court-1.json"
grep -Fq '"audio_bitrate": 128' "$FIXTURE/requests/court-1.json"
grep -Fq '"audio_frequency": 48000' "$FIXTURE/requests/court-1.json"
grep -Fq '"key_frame_interval": 2' "$FIXTURE/requests/court-1.json"
grep -Fq 'https://scorecheck-abc123-test.vercel.app/program/bootstrap?court=1&build=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&deployment=dpl_test123#token=test-program-token' "$FIXTURE/requests/court-1.json"
if grep -Fq '?token=' "$FIXTURE/requests/court-1.json"; then
  printf 'FAIL: program token remained in the request query string\n' >&2
  exit 1
fi
if grep -Fq 'test-stream-key' "$FIXTURE/start.out" || grep -Fq 'test-program-token' "$FIXTURE/start.out"; then
  printf 'FAIL: protected values appeared in start output\n' >&2
  exit 1
fi

rm -f "$FIXTURE/requests/court-1.egress-id"
PATH="$FIXTURE/bin:$PATH" "$FIXTURE/stop-court.sh" 1 >"$FIXTURE/stop.out" 2>&1
test ! -e "$FIXTURE/requests/court-1.owner.json"
grep -Fq 'court 1: stopped (ownership files cleared)' "$FIXTURE/stop.out"
printf '%s\n' 'MOCK_ACTIVE=1' >>"$FIXTURE/.env"
if PATH="$FIXTURE/bin:$PATH" "$FIXTURE/start-court.sh" 1 1080p30 event-test broadcast-test generation-test >"$FIXTURE/rejected.out" 2>&1; then
  printf 'FAIL: second active Egress was admitted\n' >&2
  exit 1
fi
grep -Fq 'already has an active Egress' "$FIXTURE/rejected.out"
test ! -e "$FIXTURE/requests/court-1.egress-id"

if PATH="$FIXTURE/bin:$PATH" "$FIXTURE/start-court.sh" 1 1080p30 event-test broadcast-test >"$FIXTURE/argument.out" 2>&1; then
  printf 'FAIL: extra command-line argument was accepted\n' >&2
  exit 1
fi
grep -Fq 'court number, output profile, event, destination id, and output generation are required' "$FIXTURE/argument.out"

if PATH="$FIXTURE/bin:$PATH" "$FIXTURE/start-court.sh" 1 auto event-test broadcast-test generation-test >"$FIXTURE/profile.out" 2>&1; then
  printf 'FAIL: unknown output profile was accepted\n' >&2
  exit 1
fi
grep -Fq 'output-profile must be 1080p30 or 1080p60' "$FIXTURE/profile.out"

printf 'PASS: Egress starts are serialized, single-job, and credential-safe\n'
