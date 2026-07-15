#!/bin/sh

set -eu

numeric() {
  value="$1"
  fallback="$2"
  case "$value" in
    ''|*[!0-9.]*) printf '%s' "$fallback" ;;
    *) printf '%s' "$value" ;;
  esac
}

parse_progress() {
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

if [ "${1:-}" = "--parse-progress" ]; then
  [ "$#" -eq 3 ] || { echo "invalid progress parser invocation" >&2; exit 64; }
  progress_file="$2"
  fifo="$3"
  # MediaMTX signals the complete external-command group. The owning runner
  # also terminates and reaps this parser after FFmpeg exits.
  trap 'exit 0' HUP INT TERM
  parse_progress
  exit 0
fi

name="${1:-}"
case "$name" in
  court[1-8]_preview|court[1-8]_program|court[1-8]_calibration|court[1-8]_monitor) ;;
  *) echo "invalid monitored FFmpeg branch" >&2; exit 64 ;;
esac
shift

wait_path=""
if [ "${1:-}" = "--wait-ready" ]; then
  [ "$#" -ge 2 ] || { echo "--wait-ready requires a path" >&2; exit 64; }
  wait_path="$2"
  case "$wait_path" in
    court[1-8]_raw) ;;
    *) echo "invalid readiness path" >&2; exit 64 ;;
  esac
  shift 2
fi
if [ "${1:-}" = "--" ]; then shift; fi

progress_dir="${FFMPEG_PROGRESS_DIR:-/monitoring/ffmpeg}"
progress_file="$progress_dir/$name.progress"
fifo="/tmp/$name-progress-$$"
parser_pid=""
ffmpeg_pid=""

stop_parser() {
  if [ -n "$parser_pid" ]; then
    kill "$parser_pid" 2>/dev/null || true
    wait "$parser_pid" 2>/dev/null || true
    rm -f "$progress_file.tmp.$parser_pid"
    parser_pid=""
  fi
}

cleanup() {
  trap - EXIT HUP INT TERM
  if [ -n "$ffmpeg_pid" ]; then
    kill "$ffmpeg_pid" 2>/dev/null || true
    wait "$ffmpeg_pid" 2>/dev/null || true
    ffmpeg_pid=""
  fi
  stop_parser
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

wait_until_ready() {
  path="$1"
  while :; do
    if wget -qO- "http://127.0.0.1:9997/v3/paths/get/$path" 2>/dev/null \
      | grep -q '"ready":true'; then
      return 0
    fi
    sleep 2
  done
}

if [ -n "$wait_path" ]; then
  wait_until_ready "$wait_path"
fi

mkdir -p "$progress_dir"
rm -f "$progress_file" "$fifo"
mkfifo -m 0600 "$fifo"
# A separately exec'd parser is explicitly terminated and reaped after FFmpeg.
# No read/write FIFO guard is opened: BusyBox ash can preserve an internal copy
# in a background child, self-hold the writer, and prevent EOF at retirement.
/bin/sh "$0" --parse-progress "$progress_file" "$fifo" 2>/dev/null &
parser_pid=$!

set +e
ffmpeg -progress "$fifo" -nostats "$@" &
ffmpeg_pid=$!
wait "$ffmpeg_pid"
status=$?
ffmpeg_pid=""
stop_parser
set -e

exit "$status"
