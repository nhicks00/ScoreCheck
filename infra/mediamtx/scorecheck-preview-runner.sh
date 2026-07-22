#!/bin/sh

set -eu

branch="${1:-}"
source_map="${2:-}"
case "$branch" in
  court[1-8]_preview) ;;
  *) echo "invalid preview branch" >&2; exit 64 ;;
esac
case "$source_map" in
  raw,raw,raw,raw,raw,raw,raw,raw|normalized,raw,raw,raw,raw,raw,raw,raw) ;;
  *)
    old_ifs=$IFS
    IFS=,
    set -- $source_map
    IFS=$old_ifs
    [ "$#" -eq 8 ] || { echo "invalid browser source map" >&2; exit 64; }
    for value in "$@"; do
      case "$value" in raw|normalized) ;; *) echo "invalid browser source map" >&2; exit 64 ;; esac
    done
    ;;
esac

court=${branch#court}
court=${court%_preview}
old_ifs=$IFS
IFS=,
set -- $source_map
IFS=$old_ifs
index=1
source_kind=""
for value in "$@"; do
  if [ "$index" -eq "$court" ]; then source_kind=$value; break; fi
  index=$((index + 1))
done
[ -n "$source_kind" ] || { echo "browser source map has no Camera $court assignment" >&2; exit 64; }

source_path="court${court}_${source_kind}"
runner=${SCORECHECK_FFMPEG_RUNNER:-/usr/local/bin/scorecheck-ffmpeg-runner}
[ -x "$runner" ] || { echo "FFmpeg branch runner is unavailable" >&2; exit 69; }
exec "$runner" "$branch" \
  --wait-ready "$source_path" -- \
  -nostdin -hide_banner -loglevel warning \
  -fflags nobuffer -flags low_delay -rtsp_transport tcp \
  -i "rtsp://127.0.0.1:${RTSP_PORT:?RTSP_PORT is required}/${source_path}" \
  -map 0:v:0 -map 0:a:0? \
  -c:v copy \
  -c:a libopus -b:a 96k -ar 48000 -ac 2 -af "aresample=async=1:first_pts=0" \
  -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:${RTSP_PORT}/${MTX_PATH:?MTX_PATH is required}"
