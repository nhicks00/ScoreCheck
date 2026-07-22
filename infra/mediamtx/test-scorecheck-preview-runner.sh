#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNNER="$SCRIPT_DIR/scorecheck-preview-runner.sh"
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

printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$@" >"$PREVIEW_RUNNER_CAPTURE"' >"$TEST_ROOT/fake-runner"
chmod 0755 "$TEST_ROOT/fake-runner"

export SCORECHECK_FFMPEG_RUNNER="$TEST_ROOT/fake-runner"
export PREVIEW_RUNNER_CAPTURE="$CAPTURE"
export RTSP_PORT=8554
export MTX_PATH=court2_preview

sh "$RUNNER" court2_preview raw,normalized,raw,raw,raw,raw,raw,raw
grep -Fxq 'court2_preview' "$CAPTURE" || fail "wrapper did not preserve the preview branch"
grep -Fxq 'court2_normalized' "$CAPTURE" || fail "wrapper did not select Camera 2 normalized input"
grep -Fxq 'rtsp://127.0.0.1:8554/court2_normalized' "$CAPTURE" || fail "wrapper did not read the normalized path"
grep -Fxq -- '-c:v' "$CAPTURE" || fail "wrapper did not configure video copy"
grep -Fxq 'copy' "$CAPTURE" || fail "wrapper transcodes browser video unexpectedly"
grep -Fxq 'libopus' "$CAPTURE" || fail "wrapper did not normalize browser audio to Opus"

export MTX_PATH=court1_preview
sh "$RUNNER" court1_preview raw,normalized,raw,raw,raw,raw,raw,raw
grep -Fxq 'court1_raw' "$CAPTURE" || fail "wrapper did not select Camera 1 raw input"
grep -Fxq 'rtsp://127.0.0.1:8554/court1_raw' "$CAPTURE" || fail "wrapper did not read the direct H264 path"

for invalid in \
  'court9_preview raw,raw,raw,raw,raw,raw,raw,raw' \
  'court1_preview raw,raw,raw' \
  'court1_preview raw,hevc,raw,raw,raw,raw,raw,raw'; do
  set -- $invalid
  if sh "$RUNNER" "$1" "$2" >/dev/null 2>&1; then
    fail "wrapper accepted invalid input: $invalid"
  fi
done

printf 'PASS: preview source selection is explicit, codec-safe, and fail-closed\n'
