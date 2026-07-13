#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNNER="$SCRIPT_DIR/scorecheck-ffmpeg-runner.sh"
TEMPLATE="$SCRIPT_DIR/mediamtx.template.yml"
TEST_ROOT="$(mktemp -d)"
MOCK_BIN="$TEST_ROOT/bin"
RUNNER_PID=""

cleanup() {
  trap - EXIT HUP INT TERM
  if [ -n "$RUNNER_PID" ]; then
    kill "$RUNNER_PID" 2>/dev/null || true
    wait "$RUNNER_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p "$MOCK_BIN" "$TEST_ROOT/progress"

cat >"$MOCK_BIN/ffmpeg" <<'MOCK'
#!/bin/sh
set -eu

progress=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-progress" ]; then
    shift
    progress="${1:-}"
  fi
  shift
done

[ -n "$progress" ] || exit 64
printf '%s\n' "$$" >"$FAKE_FFMPEG_PID_FILE"

if [ "${FAKE_FFMPEG_EXIT_EARLY:-0}" -eq 1 ]; then
  exit 42
fi

on_signal() {
  printf 'stopping\n' >"$FAKE_FFMPEG_STOP_FILE"
  sleep 0.1
  exit 0
}
trap on_signal HUP INT TERM

{
  printf 'frame=1\n'
  printf 'fps=30.0\n'
  printf 'progress=continue\n'
} >"$progress"

while :; do sleep 0.1; done
MOCK
chmod 0755 "$MOCK_BIN/ffmpeg"

export PATH="$MOCK_BIN:$PATH"
export FFMPEG_PROGRESS_DIR="$TEST_ROOT/progress"
export FAKE_FFMPEG_PID_FILE="$TEST_ROOT/ffmpeg.pid"
export FAKE_FFMPEG_STOP_FILE="$TEST_ROOT/ffmpeg.stopped"

run_shutdown_cycle() {
  shutdown_signal="$1"
  expected_status="$2"
  rm -f "$FAKE_FFMPEG_PID_FILE" "$FAKE_FFMPEG_STOP_FILE"
  sh "$RUNNER" court1_preview -- -i ignored -f null - &
  RUNNER_PID=$!

  attempt=0
  while [ ! -f "$FAKE_FFMPEG_PID_FILE" ] && [ "$attempt" -lt 100 ]; do
    attempt=$((attempt + 1))
    sleep 0.02
  done
  [ -f "$FAKE_FFMPEG_PID_FILE" ] || fail "fake FFmpeg did not start"

  ffmpeg_pid="$(cat "$FAKE_FFMPEG_PID_FILE")"
  # MediaMTX terminates the external-command process group, so the runner and
  # FFmpeg receive the same signal. The runner must still wait for the child.
  kill "-$shutdown_signal" "$RUNNER_PID" "$ffmpeg_pid"
  set +e
  wait "$RUNNER_PID"
  runner_status=$?
  set -e
  RUNNER_PID=""

  [ "$runner_status" -eq "$expected_status" ] \
    || fail "runner exited with $runner_status after SIG$shutdown_signal"
  [ -f "$FAKE_FFMPEG_STOP_FILE" ] || fail "runner did not terminate its FFmpeg child"
  if kill -0 "$ffmpeg_pid" 2>/dev/null; then
    fail "runner exited before reaping FFmpeg child $ffmpeg_pid"
  fi
  [ ! -e "$FFMPEG_PROGRESS_DIR/court1_preview.progress" ] \
    || fail "runner left stale progress state after shutdown"
}

cycle=0
for signal_and_status in TERM:143 HUP:129 TERM:143 HUP:129 TERM:143 HUP:129 TERM:143 HUP:129; do
  cycle=$((cycle + 1))
  run_shutdown_cycle "${signal_and_status%:*}" "${signal_and_status#*:}"
done

grep -Fq "trap 'exit_for_signal 130' INT" "$RUNNER" \
  || fail "runner does not install the MediaMTX SIGINT cleanup handler"
grep -Fq "trap '' HUP INT TERM" "$RUNNER" \
  || fail "progress parser can exit independently of the runner reap path"

rm -f "$FAKE_FFMPEG_PID_FILE" "$FAKE_FFMPEG_STOP_FILE"
export FAKE_FFMPEG_EXIT_EARLY=1
set +e
sh "$RUNNER" court1_preview -- -i ignored -f null -
early_status=$?
set -e
unset FAKE_FFMPEG_EXIT_EARLY
[ "$early_status" -eq 42 ] || fail "runner did not preserve early FFmpeg exit status"
[ ! -e "$FFMPEG_PROGRESS_DIR/court1_preview.progress" ] \
  || fail "early FFmpeg failure left stale progress state"

direct_exec_count="$(grep -c '^[[:space:]]*exec /usr/local/bin/scorecheck-ffmpeg-runner ' "$TEMPLATE")"
[ "$direct_exec_count" -eq 3 ] \
  || fail "expected three direct MediaMTX runner exec commands, found $direct_exec_count"
if grep -q '/bin/sh -c' "$TEMPLATE"; then
  fail "MediaMTX hooks still contain a nested shell that can orphan the runner"
fi

printf 'PASS: FFmpeg hook ownership, %s signal cycles, and early failure cleanup\n' "$cycle"
