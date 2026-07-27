#!/bin/sh

set -eu

branch="${1:-}"
source_map="${2:-}"
delay_us="${3:-}"
case "$branch" in
  court[1-8]_program) ;;
  *) echo "invalid program branch" >&2; exit 64 ;;
esac
case "$delay_us" in
  ''|*[!0-9]*) echo "invalid program delay" >&2; exit 64 ;;
esac
[ "$delay_us" -le 30000000 ] || { echo "invalid program delay" >&2; exit 64; }

old_ifs=$IFS
IFS=,
set -- $source_map
IFS=$old_ifs
[ "$#" -eq 8 ] || { echo "invalid browser source map" >&2; exit 64; }
for value in "$@"; do
  case "$value" in raw|normalized) ;; *) echo "invalid browser source map" >&2; exit 64 ;; esac
done

court=${branch#court}
court=${court%_program}
index=1
source_kind=""
for value in "$@"; do
  if [ "$index" -eq "$court" ]; then source_kind=$value; break; fi
  index=$((index + 1))
done
[ -n "$source_kind" ] || { echo "browser source map has no Camera $court assignment" >&2; exit 64; }

source_path="court${court}_${source_kind}"
readrate_args=""
if [ "$source_kind" = "normalized" ]; then
  readrate_args="-readrate 1"
fi
runner=${SCORECHECK_FFMPEG_RUNNER:-/usr/local/bin/scorecheck-ffmpeg-runner}
[ -x "$runner" ] || { echo "FFmpeg branch runner is unavailable" >&2; exit 69; }

exec "$runner" "$branch" --wait-ready "$source_path" -- \
  -nostdin -hide_banner -loglevel warning \
  -fflags +genpts+discardcorrupt \
  $readrate_args \
  -i "srt://127.0.0.1:${SRT_PORT:?SRT_PORT is required}?streamid=read:${source_path}&latency=${delay_us}&rcvbuf=33554432&timeout=60000000" \
  -map 0:v:0 -map 0:a:0? \
  -c:v copy \
  -c:a libopus -b:a 128k -ar 48000 -ac 2 -af "asetpts=N/SR/TB,aresample=async=1:first_pts=0" \
  -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:${RTSP_PORT:?RTSP_PORT is required}/${MTX_PATH:?MTX_PATH is required}"
