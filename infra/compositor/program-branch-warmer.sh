#!/bin/sh
# Hold the exact owned program branch open independently of the Egress worker.

set -eu

interval_seconds=${SCORECHECK_PROGRAM_WARMER_INTERVAL_SECONDS:-2}
request_dir=${SCORECHECK_PROGRAM_WARMER_REQUEST_DIR:-/requests}
state_dir=${SCORECHECK_PROGRAM_WARMER_STATE_DIR:-/monitoring/program-warmer}
state_file=$state_dir/state.json
court=${CAMERA_NUMBER:-}
ffmpeg_pid=""
restart_count=0

case "$interval_seconds" in ''|*[!0-9]*) echo "invalid warmer interval" >&2; exit 64 ;; esac
[ "$interval_seconds" -ge 1 ] && [ "$interval_seconds" -le 30 ] || { echo "invalid warmer interval" >&2; exit 64; }
mkdir -p "$state_dir"

write_state() {
  status=$1
  pid=${2:-null}
  observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  temporary="$state_file.tmp.$$"
  printf '{"schemaVersion":1,"court":%s,"status":"%s","ffmpegPid":%s,"restartCount":%s,"observedAt":"%s"}\n' \
    "${court:-null}" "$status" "$pid" "$restart_count" "$observed_at" >"$temporary"
  # This file contains operational status only and is mounted read-only by the
  # unprivileged monitoring agent.
  chmod 644 "$temporary"
  mv "$temporary" "$state_file"
}

stop_reader() {
  if [ -n "$ffmpeg_pid" ]; then
    kill "$ffmpeg_pid" 2>/dev/null || true
    wait "$ffmpeg_pid" 2>/dev/null || true
    ffmpeg_pid=""
  fi
}

cleanup() {
  stop_reader
  write_state STOPPED
}
trap 'exit 0' INT TERM
trap cleanup EXIT

if [ -z "$court" ]; then
  while true; do
    write_state IDLE
    sleep "$interval_seconds"
  done
fi
case "$court" in 1|2|3|4|5|6|7|8) ;; *) echo "invalid camera assignment" >&2; exit 64 ;; esac

case "${MEDIAMTX_PRIVATE_HOST:-}" in ''|*[!A-Za-z0-9.:-]*) echo "invalid MediaMTX private host" >&2; exit 64 ;; esac
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg is required" >&2; exit 69; }

owner_file="$request_dir/court-$court.owner.json"
rtsp_url="rtsp://${MEDIAMTX_PRIVATE_HOST}:8554/court${court}_program"

while true; do
  if [ ! -f "$owner_file" ] || [ -L "$owner_file" ]; then
    stop_reader
    write_state IDLE
    sleep "$interval_seconds"
    continue
  fi

  if [ -z "$ffmpeg_pid" ]; then
    ffmpeg -nostdin -hide_banner -loglevel quiet \
      -timeout 15000000 -rtsp_transport tcp \
      -i "$rtsp_url" -map 0:v:0 -c copy -f null - &
    ffmpeg_pid=$!
    restart_count=$((restart_count + 1))
  fi

  if kill -0 "$ffmpeg_pid" 2>/dev/null; then
    write_state WARM "$ffmpeg_pid"
    sleep "$interval_seconds"
    continue
  fi

  wait "$ffmpeg_pid" 2>/dev/null || true
  ffmpeg_pid=""
  write_state WAITING
  sleep "$interval_seconds"
done
