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

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$ffmpeg_pid" ]; then kill "$ffmpeg_pid" 2>/dev/null || true; fi
  if [ -n "$parser_pid" ]; then kill "$parser_pid" 2>/dev/null || true; fi
  rm -f "$fifo" "$progress_file"
}
trap cleanup EXIT INT TERM

mkdir -p "$progress_dir"
rm -f "$progress_file" "$fifo"
mkfifo -m 0600 "$fifo"

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

numeric() {
  value="$1"
  fallback="$2"
  case "$value" in
    ''|*[!0-9.]*) printf '%s' "$fallback" ;;
    *) printf '%s' "$value" ;;
  esac
}

parse_progress &
parser_pid=$!

set +e
ffmpeg -progress "$fifo" -nostats "$@" &
ffmpeg_pid=$!
wait "$ffmpeg_pid"
status=$?
ffmpeg_pid=""
wait "$parser_pid" 2>/dev/null
parser_pid=""
set -e

exit "$status"
