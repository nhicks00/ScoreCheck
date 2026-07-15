#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RUNNER="$SCRIPT_DIR/scorecheck-ffmpeg-runner.sh"
TEMPLATE="$SCRIPT_DIR/mediamtx.template.yml"
TEST_ROOT="$(mktemp -d)"
MOCK_BIN="$TEST_ROOT/bin"
RUNNER_PID=""
WAIT_GUARD_PID=""

cleanup() {
  trap - EXIT HUP INT TERM
  if [ -n "$RUNNER_PID" ]; then
    kill "$RUNNER_PID" 2>/dev/null || true
    wait "$RUNNER_PID" 2>/dev/null || true
  fi
  if [ -n "$WAIT_GUARD_PID" ]; then
    kill "$WAIT_GUARD_PID" 2>/dev/null || true
    wait "$WAIT_GUARD_PID" 2>/dev/null || true
  fi
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

wait_runner_bounded() {
  (
    sleep 5
    kill -KILL "$RUNNER_PID" 2>/dev/null || true
  ) &
  WAIT_GUARD_PID=$!

  set +e
  wait "$RUNNER_PID"
  RUNNER_STATUS=$?
  set -e

  kill "$WAIT_GUARD_PID" 2>/dev/null || true
  wait "$WAIT_GUARD_PID" 2>/dev/null || true
  WAIT_GUARD_PID=""
  [ "$RUNNER_STATUS" -ne 137 ] || fail "runner did not exit within five seconds"
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
on_signal() {
  printf 'stopping\n' >"$FAKE_FFMPEG_STOP_FILE"
  sleep 0.1
  exit 0
}
trap on_signal HUP INT TERM

printf '%s\n' "$$" >"$FAKE_FFMPEG_PID_FILE"

if [ "${FAKE_FFMPEG_EXIT_EARLY:-0}" -eq 1 ]; then
  exit 42
fi

{
  printf 'frame=1\n'
  printf 'fps=30.0\n'
  printf 'progress=continue\n'
} >"$progress"

while :; do sleep 0.1; done
MOCK
chmod 0755 "$MOCK_BIN/ffmpeg"

cat >"$MOCK_BIN/wget" <<'MOCK'
#!/bin/sh
set -eu

count=0
if [ -f "$FAKE_READY_COUNT_FILE" ]; then
  count="$(cat "$FAKE_READY_COUNT_FILE")"
fi
count=$((count + 1))
printf '%s\n' "$count" >"$FAKE_READY_COUNT_FILE"
if [ "$count" -ge 3 ]; then
  printf '%s\n' '{"ready":true}'
else
  printf '%s\n' '{"ready":false}'
fi
MOCK
chmod 0755 "$MOCK_BIN/wget"

export PATH="$MOCK_BIN:$PATH"
export FFMPEG_PROGRESS_DIR="$TEST_ROOT/progress"
export FAKE_FFMPEG_PID_FILE="$TEST_ROOT/ffmpeg.pid"
export FAKE_FFMPEG_STOP_FILE="$TEST_ROOT/ffmpeg.stopped"
export FAKE_READY_COUNT_FILE="$TEST_ROOT/wget.count"

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
  attempt=0
  while ! grep -q '^frame=1$' "$FFMPEG_PROGRESS_DIR/court1_preview.progress" 2>/dev/null \
    && [ "$attempt" -lt 100 ]; do
    attempt=$((attempt + 1))
    sleep 0.02
  done
  grep -q '^frame=1$' "$FFMPEG_PROGRESS_DIR/court1_preview.progress" 2>/dev/null \
    || fail "progress parser did not publish the FFmpeg sample"
  # MediaMTX terminates the external-command process group, so the runner and
  # FFmpeg receive the same signal. The runner must still wait for the child.
  kill "-$shutdown_signal" "$RUNNER_PID" "$ffmpeg_pid"
  wait_runner_bounded
  runner_status="$RUNNER_STATUS"
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

rm -f "$FAKE_FFMPEG_PID_FILE" "$FAKE_FFMPEG_STOP_FILE" "$FAKE_READY_COUNT_FILE"
sh "$RUNNER" court1_preview --wait-ready court1_raw -- -i ignored -f null - &
RUNNER_PID=$!
attempt=0
while [ ! -f "$FAKE_FFMPEG_PID_FILE" ] && [ "$attempt" -lt 200 ]; do
  attempt=$((attempt + 1))
  sleep 0.02
done
[ -f "$FAKE_FFMPEG_PID_FILE" ] || fail "runner did not start after the raw path became ready"
[ "$(cat "$FAKE_READY_COUNT_FILE")" -ge 3 ] \
  || fail "runner bypassed the readiness gate"
ffmpeg_pid="$(cat "$FAKE_FFMPEG_PID_FILE")"
kill -TERM "$RUNNER_PID" "$ffmpeg_pid"
wait_runner_bounded
ready_status="$RUNNER_STATUS"
RUNNER_PID=""
[ "$ready_status" -eq 143 ] || fail "readiness-gated runner exited with $ready_status"
[ ! -e "$FFMPEG_PROGRESS_DIR/court1_preview.progress" ] \
  || fail "readiness-gated runner left stale progress state"

grep -Fq "trap 'exit_for_signal 130' INT" "$RUNNER" \
  || fail "runner does not install the MediaMTX SIGINT cleanup handler"
grep -Fq 'stop_parser' "$RUNNER" \
  || fail "runner does not terminate and reap its progress parser"
grep -Fq '/bin/sh "$0" --parse-progress "$progress_file" "$fifo" 2>/dev/null &' "$RUNNER" \
  || fail "runner does not separately exec its owned progress parser"
if grep -q 'exec 7<>"$fifo"' "$RUNNER"; then
  fail "runner still gives the progress parser a self-held FIFO writer"
fi

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

direct_runner_count="$(grep -c '^[[:space:]]*/usr/local/bin/scorecheck-ffmpeg-runner ' "$TEMPLATE")"
[ "$direct_runner_count" -eq 4 ] \
  || fail "expected four direct MediaMTX runner commands, found $direct_runner_count"
wait_ready_count="$(grep -c -- '--wait-ready "court${G1}_raw"' "$TEMPLATE")"
[ "$wait_ready_count" -eq 2 ] \
  || fail "expected preview and monitor to use the runner readiness gate"
if grep -q '/bin/sh -c' "$TEMPLATE"; then
  fail "MediaMTX hooks still contain a nested shell that can orphan the runner"
fi
if grep -Eq '^[[:space:]]*(exec|while)[[:space:]]' "$TEMPLATE"; then
  fail "MediaMTX hooks still start with shell builtins"
fi

printf 'PASS: FFmpeg hook ownership, readiness, %s signal cycles, and early failure cleanup\n' "$cycle"
