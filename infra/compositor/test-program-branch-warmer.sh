#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'kill "${WARMER_PID:-}" 2>/dev/null || true; wait "${WARMER_PID:-}" 2>/dev/null || true; rm -rf "$TEST_ROOT"' EXIT
mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/requests" "$TEST_ROOT/state"
grep -Fq -- '--force-recreate renderer program-warmer' "$SCRIPT_DIR/deploy.sh"

cat >"$TEST_ROOT/bin/ffmpeg" <<'MOCK'
#!/bin/sh
printf '%s\n' "$*" >"$FAKE_FFMPEG_ARGS"
trap 'printf stopped >"$FAKE_FFMPEG_STOPPED"; exit 0' TERM INT
while true; do sleep 1; done
MOCK
chmod 0755 "$TEST_ROOT/bin/ffmpeg"

export PATH="$TEST_ROOT/bin:$PATH"
export CAMERA_NUMBER=3
export MEDIAMTX_HLS_BASE_URL=https://preview.example.test
export MEDIAMTX_READ_USER=scorecheck_event_reader
export MEDIAMTX_READ_PASS=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export SCORECHECK_PROGRAM_WARMER_INTERVAL_SECONDS=1
export SCORECHECK_PROGRAM_WARMER_REQUEST_DIR="$TEST_ROOT/requests"
export SCORECHECK_PROGRAM_WARMER_STATE_DIR="$TEST_ROOT/state"
export FAKE_FFMPEG_ARGS="$TEST_ROOT/ffmpeg.args"
export FAKE_FFMPEG_STOPPED="$TEST_ROOT/ffmpeg.stopped"

"$SCRIPT_DIR/program-branch-warmer.sh" &
WARMER_PID=$!

for _ in $(seq 1 30); do
  grep -q '"status":"IDLE"' "$TEST_ROOT/state/state.json" 2>/dev/null && break
  sleep 0.1
done
grep -q '"status":"IDLE"' "$TEST_ROOT/state/state.json"
state_mode="$(stat -c '%a' "$TEST_ROOT/state/state.json" 2>/dev/null || stat -f '%Lp' "$TEST_ROOT/state/state.json")"
[[ "$state_mode" == "644" ]]

printf '{}\n' >"$TEST_ROOT/requests/court-3.owner.json"
for _ in $(seq 1 50); do
  grep -q '"status":"WARM"' "$TEST_ROOT/state/state.json" 2>/dev/null && break
  sleep 0.1
done
grep -q '"status":"WARM"' "$TEST_ROOT/state/state.json"
grep -q 'court3_program/index.m3u8?user=scorecheck_event_reader&pass=' "$TEST_ROOT/ffmpeg.args"
grep -q -- '-map 0:v:0' "$TEST_ROOT/ffmpeg.args"
! grep -q -- '-map 0:a:0' "$TEST_ROOT/ffmpeg.args"
grep -q -- '-c copy -f null -' "$TEST_ROOT/ffmpeg.args"

rm "$TEST_ROOT/requests/court-3.owner.json"
for _ in $(seq 1 50); do
  [[ -f "$TEST_ROOT/ffmpeg.stopped" ]] && grep -q '"status":"IDLE"' "$TEST_ROOT/state/state.json" && break
  sleep 0.1
done
[[ -f "$TEST_ROOT/ffmpeg.stopped" ]]
grep -q '"status":"IDLE"' "$TEST_ROOT/state/state.json"

echo "program branch warmer tests passed"
