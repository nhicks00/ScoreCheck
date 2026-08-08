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
export MTX_PATH=court2_program

sh "$RUNNER" court2_program raw,normalized,raw,raw,raw,raw,raw,raw
grep -Fxq 'court2_program' "$CAPTURE" || fail "wrapper did not preserve the program branch"
grep -Fxq -- '--wait-ready' "$CAPTURE" || fail "wrapper did not wait for its selected source"
grep -Fxq 'court2_normalized' "$CAPTURE" || fail "wrapper waited for the wrong source"
grep -Fxq 'rtsp://127.0.0.1:8554/court2_normalized' "$CAPTURE" || fail "wrapper did not select the restart-safe Camera 2 input"
grep -Fxq -- '-rtsp_transport' "$CAPTURE" || fail "wrapper did not use private RTSP"
if grep -Fq 'srt://' "$CAPTURE"; then
  fail "program input still depends on a parameter-losing SRT self-read"
fi
grep -Fxq 'copy' "$CAPTURE" || fail "wrapper transcodes browser video unexpectedly"
grep -Fxq 'aac' "$CAPTURE" || fail "wrapper did not normalize program audio to HLS-safe AAC"
grep -Fq 'aresample=async=1:first_pts=0' "$CAPTURE" || fail "program audio does not preserve the source timeline"
if grep -Fq 'asetpts=N/' "$CAPTURE"; then
  fail "program audio is independently restamped from copied video"
fi
if grep -Fq 'court2_preview' "$CAPTURE"; then
  fail "program still depends on the preview RTSP branch"
fi

export MTX_PATH=court1_program
sh "$RUNNER" court1_program raw,normalized,raw,raw,raw,raw,raw,raw
grep -Fxq 'rtsp://127.0.0.1:8554/court1_raw' "$CAPTURE" || fail "wrapper did not select Camera 1 raw input"

for invalid in \
  'court9_program raw,raw,raw,raw,raw,raw,raw,raw' \
  'court1_program raw,raw,raw' \
  'court1_program raw,hevc,raw,raw,raw,raw,raw,raw' \
  'court1_program raw,raw,raw,raw,raw,raw,raw,raw unexpected'; do
  set -- $invalid
  if sh "$RUNNER" "$@" >/dev/null 2>&1; then
    fail "wrapper accepted invalid input: $invalid"
  fi
done

printf 'PASS: program source selection uses restart-safe private RTSP and emits HLS-safe audio\n'
