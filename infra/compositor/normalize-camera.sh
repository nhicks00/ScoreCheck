#!/bin/sh

set -eu

[ "${CAMERA_NORMALIZER_ENABLED:-}" = "true" ] || { echo "error: Camera normalizer is not enabled for this host" >&2; exit 64; }
[ "${CAMERA_SOURCE_PATH_MODE:-}" = "isolated-hevc-normalizer" ] || { echo "error: Camera source path is not assigned to the isolated normalizer" >&2; exit 64; }
[ "${CAMERA_SOURCE_CODEC:-}" = "H265" ] || { echo "error: Camera normalizer requires H265 input" >&2; exit 64; }

court=${CAMERA_NUMBER:-}
case "$court" in [1-8]) ;; *) echo "error: CAMERA_NUMBER must be 1-8" >&2; exit 64 ;; esac
[ "${CAMERA_NORMALIZER_INPUT_PATH:-}" = "court${court}_raw" ] || { echo "error: normalizer input path does not match Camera $court" >&2; exit 64; }
[ "${CAMERA_NORMALIZER_OUTPUT_PATH:-}" = "court${court}_normalized" ] || { echo "error: normalizer output path does not match Camera $court" >&2; exit 64; }

host=${MEDIAMTX_PRIVATE_HOST:-}
old_ifs=$IFS
IFS=.
set -- $host
IFS=$old_ifs
[ "$#" -eq 4 ] || { echo "error: MEDIAMTX_PRIVATE_HOST must be a private IPv4 address" >&2; exit 64; }
for octet in "$@"; do
  case "$octet" in ''|*[!0-9]*) echo "error: MEDIAMTX_PRIVATE_HOST must be a private IPv4 address" >&2; exit 64 ;; esac
  [ "$octet" -le 255 ] || { echo "error: MEDIAMTX_PRIVATE_HOST must be a private IPv4 address" >&2; exit 64; }
done
case "$1:$2" in
  10:*|192:168) ;;
  172:*) [ "$2" -ge 16 ] && [ "$2" -le 31 ] || { echo "error: MEDIAMTX_PRIVATE_HOST must be a private IPv4 address" >&2; exit 64; } ;;
  *) echo "error: MEDIAMTX_PRIVATE_HOST must be a private IPv4 address" >&2; exit 64 ;;
esac

case "${CAMERA_SOURCE_PROFILE:-}:${CAMERA_FRAME_RATE_MODE:-}" in
  CONSTRAINED_1080P30:30000/1001|STANDARD_1080P30:30000/1001)
    fps=30000/1001; gop=60; video_kbps=10000 ;;
  CONSTRAINED_1080P30:30/1|STANDARD_1080P30:30/1)
    fps=30; gop=60; video_kbps=10000 ;;
  PRIORITY_1080P60:60000/1001)
    fps=60000/1001; gop=120; video_kbps=12000 ;;
  PRIORITY_1080P60:60/1)
    fps=60; gop=120; video_kbps=12000 ;;
  *) echo "error: source profile and frame-rate assignment do not match" >&2; exit 64 ;;
esac

ffmpeg=${NORMALIZER_FFMPEG_BIN:-ffmpeg}
command -v "$ffmpeg" >/dev/null 2>&1 || { echo "error: FFmpeg is unavailable" >&2; exit 69; }
progress_dir=${NORMALIZER_PROGRESS_DIR:-/monitoring/ffmpeg}
[ -d "$progress_dir" ] && [ -w "$progress_dir" ] || { echo "error: normalizer progress directory is unavailable" >&2; exit 73; }
progress="${progress_dir}/court${court}_normalizer.progress"
rm -f "$progress"

exec "$ffmpeg" \
  -nostdin -hide_banner -loglevel warning \
  -progress "$progress" -stats_period 1 \
  -fflags +genpts+discardcorrupt -flags low_delay -rtsp_transport tcp \
  -i "rtsp://${host}:8554/${CAMERA_NORMALIZER_INPUT_PATH}" \
  -map 0:v:0 -map 0:a:0 \
  -vf "format=yuv420p,setfield=prog" -fps_mode cfr \
  -c:v libx264 -preset veryfast -tune zerolatency -profile:v high -level:v 4.2 \
  -r "$fps" -g "$gop" -keyint_min "$gop" -sc_threshold 0 -bf 0 \
  -b:v "${video_kbps}k" -minrate "${video_kbps}k" -maxrate "${video_kbps}k" -bufsize "$((video_kbps * 2))k" \
  -x264-params "nal-hrd=cbr:force-cfr=1:bframes=0:keyint=${gop}:min-keyint=${gop}:scenecut=0" \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv \
  -c:a libopus -b:a 128k -ar 48000 -ac 2 -af "aresample=async=1:first_pts=0" \
  -f rtsp -rtsp_transport tcp "rtsp://${host}:8554/${CAMERA_NORMALIZER_OUTPUT_PATH}"
