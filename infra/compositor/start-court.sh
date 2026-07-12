#!/usr/bin/env bash
# start-court.sh — start a LiveKit Web Egress that captures court N's program
# page (headless Chrome) and pushes it to YouTube RTMP.
#
# Usage:
#   ./start-court.sh <court-number> [youtube-stream-key]
#
#   court-number        1-8
#   youtube-stream-key  optional; defaults to COURT_<N>_YOUTUBE_KEY from .env
# Examples:
#   ./start-court.sh 1                          # key from COURT_1_YOUTUBE_KEY
#   ./start-court.sh 3 abcd-efgh-ijkl-mnop      # explicit key
#
# Requires the LiveKit CLI (see lib.sh for install commands) and a filled-in
# ./.env (see .env.example). Writes:
#   requests/court-<N>.json       generated WebEgressRequest (gitignored — holds
#                                 the stream key)
#   requests/court-<N>.egress-id  the started egress id, consumed by stop-court.sh

set -euo pipefail

# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

COURT="${1:?usage: start-court.sh <court-number> [youtube-stream-key]}"
if ! [[ "$COURT" =~ ^[0-9]+$ ]]; then
  echo "error: court-number must be an integer, got '$COURT'" >&2
  exit 1
fi

load_env
require_livekit_env
find_lk

# --- resolve inputs: args win over .env -----------------------------------------
KEY_VAR="COURT_${COURT}_YOUTUBE_KEY"
STREAM_KEY="${2:-${!KEY_VAR:-}}"
if [[ -z "$STREAM_KEY" ]]; then
  echo "error: no YouTube stream key for court $COURT." >&2
  echo "  pass it as arg 2, or set $KEY_VAR in $COMPOSITOR_DIR/.env" >&2
  exit 1
fi

YOUTUBE_RTMPS_BASE="${YOUTUBE_RTMPS_BASE:-rtmps://a.rtmps.youtube.com/live2}"
: "${PROGRAM_PAGE_BASE_URL:?set PROGRAM_PAGE_BASE_URL in .env (see .env.example)}"
: "${PROGRAM_PAGE_TOKEN:?set PROGRAM_PAGE_TOKEN in .env (see .env.example)}"

EGRESS_WIDTH="${EGRESS_WIDTH:-1280}"
EGRESS_HEIGHT="${EGRESS_HEIGHT:-720}"
EGRESS_FRAMERATE="${EGRESS_FRAMERATE:-30}"
EGRESS_VIDEO_BITRATE="${EGRESS_VIDEO_BITRATE:-4000}"
EGRESS_AUDIO_BITRATE="${EGRESS_AUDIO_BITRATE:-128}"
EGRESS_AUDIO_FREQUENCY="${EGRESS_AUDIO_FREQUENCY:-48000}"
EGRESS_KEYFRAME_INTERVAL="${EGRESS_KEYFRAME_INTERVAL:-2}"

PAGE_URL="${PROGRAM_PAGE_BASE_URL}/${COURT}?token=${PROGRAM_PAGE_TOKEN}"
RTMP_URL="${YOUTUBE_RTMPS_BASE}/${STREAM_KEY}"

# --- generate the WebEgressRequest (protojson) ----------------------------------
# await_start_signal: capture holds until the page console.log()s START_RECORDING,
# which the program page emits only once its WHEP video + commentary audio are
# actually up — so we never broadcast a half-loaded scene (plan §3.3).
# The stream output's protocol is inferred from the rtmps:// URL.
REQ_DIR="$COMPOSITOR_DIR/requests"
mkdir -p "$REQ_DIR"
REQ_FILE="$REQ_DIR/court-${COURT}.json"

cat > "$REQ_FILE" <<EOF
{
  "url": "${PAGE_URL}",
  "audio_only": false,
  "video_only": false,
  "await_start_signal": true,
  "advanced": {
    "width": ${EGRESS_WIDTH},
    "height": ${EGRESS_HEIGHT},
    "framerate": ${EGRESS_FRAMERATE},
    "audio_codec": "AAC",
    "audio_bitrate": ${EGRESS_AUDIO_BITRATE},
    "audio_frequency": ${EGRESS_AUDIO_FREQUENCY},
    "video_codec": "H264_HIGH",
    "video_bitrate": ${EGRESS_VIDEO_BITRATE},
    "key_frame_interval": ${EGRESS_KEYFRAME_INTERVAL}
  },
  "stream_outputs": [
    {
      "urls": ["${RTMP_URL}"]
    }
  ]
}
EOF
chmod 600 "$REQ_FILE" # contains the stream key

echo "court ${COURT}: starting web egress"
echo "  page:   ${PROGRAM_PAGE_BASE_URL}/${COURT}?token=<redacted>"
echo "  rtmps:  ${YOUTUBE_RTMPS_BASE}/<key-redacted>"
echo "  encode: ${EGRESS_WIDTH}x${EGRESS_HEIGHT}@${EGRESS_FRAMERATE} ${EGRESS_VIDEO_BITRATE}kbps, keyframe ${EGRESS_KEYFRAME_INTERVAL}s"

OUT="$("$LK" egress start --type web "$REQ_FILE")"
echo "$OUT"

# lk prints "EgressID: EG_xxxx Status: EGRESS_STARTING" on success; persist the
# id so stop-court.sh can end this broadcast without a lookup.
EGRESS_ID="$(grep -oE 'EG_[A-Za-z0-9]+' <<<"$OUT" | head -n1 || true)"
if [[ -n "$EGRESS_ID" ]]; then
  echo "$EGRESS_ID" > "$REQ_DIR/court-${COURT}.egress-id"
  echo "saved egress id ${EGRESS_ID} -> requests/court-${COURT}.egress-id"
else
  echo "warning: could not parse an egress id from the CLI output above;" >&2
  echo "         find it with ./list-egress.sh and stop with: ./stop-court.sh ${COURT} <EG_...>" >&2
fi
