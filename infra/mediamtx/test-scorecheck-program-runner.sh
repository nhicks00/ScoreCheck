#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNNER="$SCRIPT_DIR/scorecheck-program-runner.sh"
TEST_ROOT="$(mktemp -d)"
CAPTURE="$TEST_ROOT/arguments"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$@" >"$PROGRAM_RUNNER_CAPTURE"' >"$TEST_ROOT/fake-runner"
chmod 0755 "$TEST_ROOT/fake-runner"

export SCORECHECK_FFMPEG_RUNNER="$TEST_ROOT/fake-runner"
export PROGRAM_RUNNER_CAPTURE="$CAPTURE"
export RTSP_PORT=8554
export SRT_PORT=8890
export MTX_PATH=court2_program

sh "$RUNNER" court2_program raw,normalized,raw,raw,raw,raw,raw,raw 3500000
grep -Fxq 'court2_program' "$CAPTURE" || fail "wrapper did not preserve the program branch"
grep -Fxq -- '--wait-ready' "$CAPTURE" || fail "wrapper did not wait for its selected source"
grep -Fxq 'court2_normalized' "$CAPTURE" || fail "wrapper waited for the wrong source"
grep -Fq 'streamid=read:court2_normalized' "$CAPTURE" || fail "wrapper did not select Camera 2 normalized input"
grep -Fq 'latency=3500000' "$CAPTURE" || fail "wrapper did not preserve the configured delay"
grep -Fq 'timeout=60000000' "$CAPTURE" || fail "wrapper does not bound the delayed input timeout"
grep -Fxq 'copy' "$CAPTURE" || fail "wrapper transcodes browser video unexpectedly"
grep -Fxq 'aac' "$CAPTURE" || fail "wrapper did not normalize delayed audio to HLS-safe AAC"
grep -Fq 'aresample=async=1:first_pts=0' "$CAPTURE" || fail "delayed audio does not preserve the source timeline"
if grep -Fq 'asetpts=N/' "$CAPTURE"; then
  fail "delayed audio is independently restamped from copied video"
fi
if grep -Fq 'court2_preview' "$CAPTURE"; then
  fail "program still depends on the preview RTSP branch"
fi

export MTX_PATH=court1_program
sh "$RUNNER" court1_program raw,normalized,raw,raw,raw,raw,raw,raw 0
grep -Fq 'streamid=read:court1_raw' "$CAPTURE" || fail "wrapper did not select Camera 1 raw input"
grep -Fq 'latency=0' "$CAPTURE" || fail "wrapper rejected the zero-delay boundary"

for invalid in \
  'court9_program raw,raw,raw,raw,raw,raw,raw,raw 3500000' \
  'court1_program raw,raw,raw 3500000' \
  'court1_program raw,hevc,raw,raw,raw,raw,raw,raw 3500000' \
  'court1_program raw,raw,raw,raw,raw,raw,raw,raw -1' \
  'court1_program raw,raw,raw,raw,raw,raw,raw,raw 30000001'; do
  set -- $invalid
  if sh "$RUNNER" "$1" "$2" "$3" >/dev/null 2>&1; then
    fail "wrapper accepted invalid input: $invalid"
  fi
done

printf 'PASS: program source selection bypasses preview and emits HLS-safe delayed audio\n'
