#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/bin"
cp "$SCRIPT_DIR/start-court.sh" "$SCRIPT_DIR/lib.sh" "$FIXTURE/"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$FIXTURE/bin/flock"
ln -s "$(command -v jq)" "$FIXTURE/bin/jq"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "$*" == "egress list --active --json" ]]; then' \
  '  printf '\''Using protected LiveKit credentials\n'\'' >&2' \
  '  if [[ "${MOCK_ACTIVE:-0}" == 1 ]]; then printf '\''[{"egress_id":"EG_existing"}]'\''; else printf '\''null'\''; fi' \
  'elif [[ "$*" == egress\ start\ --type\ web* ]]; then' \
  '  printf '\''EgressID: EG_new Status: EGRESS_STARTING\n'\''' \
  'else' \
  '  exit 2' \
  'fi' >"$FIXTURE/bin/lk"
chmod 755 "$FIXTURE/bin/flock" "$FIXTURE/bin/lk" "$FIXTURE/start-court.sh"

printf '%s\n' \
  'LIVEKIT_API_KEY=test-key' \
  'LIVEKIT_API_SECRET=test-secret-long-enough' \
  'PROGRAM_PAGE_BASE_URL=https://example.test/program/court' \
  'PROGRAM_PAGE_TOKEN=test-program-token' \
  'COURT_1_YOUTUBE_KEY=test-stream-key' >"$FIXTURE/.env"

PATH="$FIXTURE/bin:$PATH" "$FIXTURE/start-court.sh" 1 1080p30 >"$FIXTURE/start.out" 2>&1
grep -Fxq 'EG_new' "$FIXTURE/requests/court-1.egress-id"
test ! -e "$FIXTURE/requests/court-1.start.log"
grep -Fq '"width": 1920' "$FIXTURE/requests/court-1.json"
grep -Fq '"height": 1080' "$FIXTURE/requests/court-1.json"
grep -Fq '"framerate": 30' "$FIXTURE/requests/court-1.json"
grep -Fq '"video_bitrate": 10000' "$FIXTURE/requests/court-1.json"
if grep -Fq 'test-stream-key' "$FIXTURE/start.out" || grep -Fq 'test-program-token' "$FIXTURE/start.out"; then
  printf 'FAIL: protected values appeared in start output\n' >&2
  exit 1
fi

rm -f "$FIXTURE/requests/court-1.egress-id"
printf '%s\n' 'MOCK_ACTIVE=1' >>"$FIXTURE/.env"
if PATH="$FIXTURE/bin:$PATH" "$FIXTURE/start-court.sh" 1 1080p30 >"$FIXTURE/rejected.out" 2>&1; then
  printf 'FAIL: second active Egress was admitted\n' >&2
  exit 1
fi
grep -Fq 'already has an active Egress' "$FIXTURE/rejected.out"
test ! -e "$FIXTURE/requests/court-1.egress-id"

if PATH="$FIXTURE/bin:$PATH" "$FIXTURE/start-court.sh" 1 1080p30 forbidden-key >"$FIXTURE/argument.out" 2>&1; then
  printf 'FAIL: extra command-line argument was accepted\n' >&2
  exit 1
fi
grep -Fq 'only court number and an allowlisted output profile' "$FIXTURE/argument.out"

if PATH="$FIXTURE/bin:$PATH" "$FIXTURE/start-court.sh" 1 auto >"$FIXTURE/profile.out" 2>&1; then
  printf 'FAIL: unknown output profile was accepted\n' >&2
  exit 1
fi
grep -Fq 'output-profile must be 720p30, 1080p30, or 1080p60' "$FIXTURE/profile.out"

printf 'PASS: Egress starts are serialized, single-job, and credential-safe\n'
