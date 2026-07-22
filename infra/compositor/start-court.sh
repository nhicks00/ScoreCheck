#!/usr/bin/env bash
# start-court.sh — start a LiveKit Web Egress that captures court N's program
# page (headless Chrome) and pushes it to YouTube RTMP.
#
# Usage:
#   ./start-court.sh <court-number> <output-profile> <event> <destination-id> <output-generation>
#
#   court-number  1-8; the stream key is read only from COURT_<N>_YOUTUBE_KEY
#   output-profile  one of: 1080p30, 1080p60
# Examples:
#   ./start-court.sh 1 1080p30 event-2026 broadcast123 generation123
#
# Requires the LiveKit CLI (see lib.sh for install commands) and a filled-in
# ./.env (see .env.example). Writes:
#   requests/court-<N>.json       generated WebEgressRequest (gitignored — holds
#                                 the stream key)
#   requests/court-<N>.egress-id   the started egress id, consumed by stop-court.sh
#   requests/court-<N>.owner.json  immutable event/destination/generation owner

set -euo pipefail
umask 077

# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if (( $# != 5 )); then
  echo "error: court number, output profile, event, destination id, and output generation are required; stream keys must come from the protected .env." >&2
  exit 1
fi
COURT="$1"
OUTPUT_PROFILE="$2"
EVENT_ID="$3"
DESTINATION_ID="$4"
OUTPUT_GENERATION="$5"
if ! [[ "$COURT" =~ ^[0-9]+$ ]]; then
  echo "error: court-number must be an integer, got '$COURT'" >&2
  exit 1
fi
for binding in "$EVENT_ID" "$DESTINATION_ID" "$OUTPUT_GENERATION"; do
  if ! [[ "$binding" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$ ]]; then
    echo "error: event, destination id, and output generation must be 3-128 safe identifier characters." >&2
    exit 1
  fi
done

load_env
require_livekit_env
find_lk

# The selected profile is authoritative. Values left in an old .env must not
# silently downgrade or otherwise alter the final YouTube output.
case "$OUTPUT_PROFILE" in
  1080p30)
    EGRESS_WIDTH=1920
    EGRESS_HEIGHT=1080
    EGRESS_FRAMERATE=30
    EGRESS_VIDEO_BITRATE=10000
    ;;
  1080p60)
    EGRESS_WIDTH=1920
    EGRESS_HEIGHT=1080
    EGRESS_FRAMERATE=60
    EGRESS_VIDEO_BITRATE=12000
    ;;
  *)
    echo "error: output-profile must be 1080p30 or 1080p60, got '$OUTPUT_PROFILE'." >&2
    exit 1
    ;;
esac
EGRESS_AUDIO_BITRATE=128
EGRESS_AUDIO_FREQUENCY=48000
EGRESS_KEYFRAME_INTERVAL=2

# Serialize the active-list check and start request. This host is qualified for
# exactly one web Egress; LiveKit's native can-accept metric has oscillated
# under load, so operator starts also enforce the hard ceiling locally.
REQ_DIR="$COMPOSITOR_DIR/requests"
mkdir -p "$REQ_DIR"
command -v flock >/dev/null 2>&1 || {
  echo "error: flock is required for serialized Egress admission." >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  echo "error: jq is required for structured Egress admission checks." >&2
  exit 1
}
command -v openssl >/dev/null 2>&1 || {
  echo "error: openssl is required for Egress request ownership hashing." >&2
  exit 1
}
exec 9>"$REQ_DIR/start.lock"
flock -n 9 || {
  echo "error: another Egress start is already in progress." >&2
  exit 1
}
ACTIVE_FILE="$(mktemp "$REQ_DIR/.active-egress.XXXXXX")"
ACTIVE_ERROR="$(mktemp "$REQ_DIR/.active-egress-error.XXXXXX")"
trap 'rm -f "$ACTIVE_FILE" "$ACTIVE_ERROR"' EXIT
if ! "$LK" egress list --active --json >"$ACTIVE_FILE" 2>"$ACTIVE_ERROR"; then
  echo "error: could not verify the active Egress count; start rejected." >&2
  exit 1
fi
if ! ACTIVE_COUNT="$(jq -er '
  if . == null then 0
  elif type == "array" and all(.[]; (.egress_id | type) == "string") then length
  else error("unexpected Egress list JSON")
  end
' "$ACTIVE_FILE")"; then
  echo "error: active Egress response was malformed; start rejected." >&2
  exit 1
fi
if (( ACTIVE_COUNT != 0 )); then
  echo "error: this compositor already has an active Egress; start rejected." >&2
  exit 1
fi

# --- resolve protected inputs ---------------------------------------------------
KEY_VAR="COURT_${COURT}_YOUTUBE_KEY"
STREAM_KEY="${!KEY_VAR:-}"
if [[ -z "$STREAM_KEY" ]]; then
  echo "error: no YouTube stream key for court $COURT." >&2
  echo "  set $KEY_VAR in $COMPOSITOR_DIR/.env" >&2
  exit 1
fi

YOUTUBE_RTMPS_BASE="${YOUTUBE_RTMPS_BASE:-rtmps://a.rtmps.youtube.com/live2}"
: "${PROGRAM_PAGE_BASE_URL:?set PROGRAM_PAGE_BASE_URL in .env (see .env.example)}"
: "${PROGRAM_PAGE_TOKEN:?set PROGRAM_PAGE_TOKEN in .env (see .env.example)}"
: "${PROGRAM_RENDERER_GIT_SHA:?set PROGRAM_RENDERER_GIT_SHA in .env (see .env.example)}"
: "${PROGRAM_RENDERER_DEPLOYMENT_ID:?set PROGRAM_RENDERER_DEPLOYMENT_ID in .env (see .env.example)}"
if ! [[ "$PROGRAM_PAGE_BASE_URL" =~ ^https://[a-z0-9-]+\.vercel\.app/program$ ]]; then
  echo "error: PROGRAM_PAGE_BASE_URL must use the immutable generated Vercel deployment URL ending in /program." >&2
  exit 1
fi
if ! [[ "$PROGRAM_RENDERER_GIT_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo "error: PROGRAM_RENDERER_GIT_SHA must be the exact 40-character renderer commit." >&2
  exit 1
fi
if ! [[ "$PROGRAM_RENDERER_DEPLOYMENT_ID" =~ ^dpl_[A-Za-z0-9]+$ ]]; then
  echo "error: PROGRAM_RENDERER_DEPLOYMENT_ID is invalid." >&2
  exit 1
fi

PROGRAM_TOKEN_FRAGMENT="$(printf '%s' "$PROGRAM_PAGE_TOKEN" | jq -sRr @uri)"
PAGE_URL="${PROGRAM_PAGE_BASE_URL}/bootstrap?court=${COURT}&build=${PROGRAM_RENDERER_GIT_SHA}&deployment=${PROGRAM_RENDERER_DEPLOYMENT_ID}#token=${PROGRAM_TOKEN_FRAGMENT}"
RTMP_URL="${YOUTUBE_RTMPS_BASE}/${STREAM_KEY}"

# --- generate the WebEgressRequest (protojson) ----------------------------------
# await_start_signal: capture holds until the page console.log()s START_RECORDING,
# which the program page emits only once its WHEP video + commentary audio are
# actually up — so we never broadcast a half-loaded scene (plan §3.3).
# The stream output's protocol is inferred from the rtmps:// URL.
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
echo "  page:   ${PROGRAM_PAGE_BASE_URL}/bootstrap?court=${COURT}&build=${PROGRAM_RENDERER_GIT_SHA}&deployment=${PROGRAM_RENDERER_DEPLOYMENT_ID}#token=<redacted>"
echo "  rtmps:  ${YOUTUBE_RTMPS_BASE}/<key-redacted>"
echo "  encode: ${OUTPUT_PROFILE} (${EGRESS_WIDTH}x${EGRESS_HEIGHT}@${EGRESS_FRAMERATE} ${EGRESS_VIDEO_BITRATE}kbps), keyframe ${EGRESS_KEYFRAME_INTERVAL}s"

START_LOG="$REQ_DIR/court-${COURT}.start.log"
if ! "$LK" egress start --type web "$REQ_FILE" >"$START_LOG" 2>&1; then
  chmod 600 "$START_LOG"
  echo "error: Egress start failed; protected diagnostics are in requests/court-${COURT}.start.log." >&2
  exit 1
fi
chmod 600 "$START_LOG"

# lk prints "EgressID: EG_xxxx Status: EGRESS_STARTING" on success; persist the
# id so stop-court.sh can end this broadcast without a lookup.
EGRESS_ID="$(grep -oE 'EG_[A-Za-z0-9]+' "$START_LOG" | head -n1 || true)"
if [[ -n "$EGRESS_ID" ]]; then
  REQUEST_SHA256="$(openssl dgst -sha256 -r "$REQ_FILE" | awk '{print $1}')"
  ID_FILE="$REQ_DIR/court-${COURT}.egress-id"
  OWNER_FILE="$REQ_DIR/court-${COURT}.owner.json"
  printf '%s\n' "$EGRESS_ID" >"${ID_FILE}.tmp"
  jq -n \
    --arg event "$EVENT_ID" \
    --argjson court "$COURT" \
    --arg destinationId "$DESTINATION_ID" \
    --arg outputGeneration "$OUTPUT_GENERATION" \
    --arg outputProfile "$OUTPUT_PROFILE" \
    --arg rendererGitSha "$PROGRAM_RENDERER_GIT_SHA" \
    --arg rendererDeploymentId "$PROGRAM_RENDERER_DEPLOYMENT_ID" \
    --arg egressId "$EGRESS_ID" \
    --arg requestSha256 "$REQUEST_SHA256" \
    --arg startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion: 1, event: $event, court: $court, destinationId: $destinationId, outputGeneration: $outputGeneration, outputProfile: $outputProfile, rendererGitSha: $rendererGitSha, rendererDeploymentId: $rendererDeploymentId, egressId: $egressId, requestSha256: $requestSha256, startedAt: $startedAt}' \
    >"${OWNER_FILE}.tmp"
  chmod 600 "${ID_FILE}.tmp" "${OWNER_FILE}.tmp"
  mv "${OWNER_FILE}.tmp" "$OWNER_FILE"
  mv "${ID_FILE}.tmp" "$ID_FILE"
  rm -f "$START_LOG"
  echo "saved owned egress id ${EGRESS_ID} -> requests/court-${COURT}.owner.json"
else
  echo "error: Egress started but its id could not be parsed; protected diagnostics remain in requests/court-${COURT}.start.log." >&2
  exit 1
fi
