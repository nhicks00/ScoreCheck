#!/bin/sh

set -eu

name="${1:-}"
case "$name" in
  court[1-8]_preview|court[1-8]_program|court[1-8]_calibration) ;;
  *) echo "invalid monitored FFmpeg branch" >&2; exit 64 ;;
esac
shift
if [ "${1:-}" = "--" ]; then shift; fi

progress_dir="${FFMPEG_PROGRESS_DIR:-/monitoring/ffmpeg}"
progress_file="$progress_dir/$name.progress"
fifo="/tmp/$name-progress-$$"
parser_pid=""
ffmpeg_pid=""
fifo_guard_open=0

close_fifo_guard() {
  if [ "$fifo_guard_open" -eq 1 ]; then
    exec 7>&-
    fifo_guard_open=0
  fi
}

cleanup() {
  trap - EXIT HUP INT TERM
  if [ -n "$ffmpeg_pid" ]; then
    kill "$ffmpeg_pid" 2>/dev/null || true
    wait "$ffmpeg_pid" 2>/dev/null || true
    ffmpeg_pid=""
  fi
  close_fifo_guard
  if [ -n "$parser_pid" ]; then
    wait "$parser_pid" 2>/dev/null || true
    parser_pid=""
  fi
  rm -f "$fifo" "$progress_file"
}

exit_for_signal() {
  status="$1"
  cleanup
  exit "$status"
}

trap cleanup EXIT
trap 'exit_for_signal 129' HUP
trap 'exit_for_signal 130' INT
trap 'exit_for_signal 143' TERM

mkdir -p "$progress_dir"
rm -f "$progress_file" "$fifo"
mkfifo -m 0600 "$fifo"
# Keep one read/write descriptor open so the parser cannot block forever if
# FFmpeg fails before opening its progress writer. Closing it produces EOF.
exec 7<>"$fifo"
fifo_guard_open=1

parse_progress() {
  # The runner owns parser shutdown by closing the FIFO guard. Ignoring the
  # external-command group signal lets this shell finish and reap atomic writes.
  trap '' HUP INT TERM
  frame=0
  fps=""
  bitrate_kbps=""
  out_time_us=""
  dup_frames=0
  drop_frames=0
  speed=""

  write_progress() {
    tmp="$progress_file.tmp.$$"
    umask 022
    {
      printf 'frame=%s\n' "$frame"
      printf 'fps=%s\n' "$fps"
      printf 'bitrate_kbps=%s\n' "$bitrate_kbps"
      printf 'out_time_us=%s\n' "$out_time_us"
      printf 'dup_frames=%s\n' "$dup_frames"
      printf 'drop_frames=%s\n' "$drop_frames"
      printf 'speed=%s\n' "$speed"
    } > "$tmp"
    mv -f "$tmp" "$progress_file"
  }

  write_progress
  while IFS='=' read -r key value; do
    case "$key" in
      frame) frame="$(numeric "$value" 0)" ;;
      fps) fps="$(numeric "$value" '')" ;;
      bitrate) bitrate_kbps="$(numeric "${value%kbits/s}" '')" ;;
      out_time_us) out_time_us="$(numeric "$value" '')" ;;
      dup_frames) dup_frames="$(numeric "$value" 0)" ;;
      drop_frames) drop_frames="$(numeric "$value" 0)" ;;
      speed) speed="$(numeric "${value%x}" '')" ;;
      progress) write_progress ;;
    esac
  done < "$fifo"
}

numeric() {
  value="$1"
  fallback="$2"
  case "$value" in
    ''|*[!0-9.]*) printf '%s' "$fallback" ;;
    *) printf '%s' "$value" ;;
  esac
}

# The parser must not inherit the guard's write end or it can never observe EOF.
parse_progress 7>&- &
parser_pid=$!

set +e
ffmpeg -progress "$fifo" -nostats "$@" &
ffmpeg_pid=$!
wait "$ffmpeg_pid"
status=$?
ffmpeg_pid=""
close_fifo_guard
wait "$parser_pid" 2>/dev/null
parser_pid=""
set -e

exit "$status"
