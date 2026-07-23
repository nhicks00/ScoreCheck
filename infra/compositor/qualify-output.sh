#!/usr/bin/env bash
# Capture one short, local-only Web Egress sample for actual encoder inspection.
# No RTMP/SRT destination is configured, so this cannot publish a broadcast.

set -euo pipefail
umask 077

# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if (( $# != 3 )); then
  echo "error: usage: qualify-output.sh <court-number> <1080p30|1080p60> <evidence-id>" >&2
  exit 1
fi
COURT="$1"
OUTPUT_PROFILE="$2"
EVIDENCE_ID="$3"
if ! [[ "$COURT" =~ ^[1-8]$ ]]; then
  echo "error: court-number must be from 1 through 8." >&2
  exit 1
fi
if ! [[ "$EVIDENCE_ID" =~ ^[A-Za-z0-9-]{8,80}$ ]]; then
  echo "error: evidence-id is invalid." >&2
  exit 1
fi

case "$OUTPUT_PROFILE" in
  1080p30)
    EGRESS_FRAMERATE=30
    EGRESS_VIDEO_BITRATE=10000
    ;;
  1080p60)
    EGRESS_FRAMERATE=60
    EGRESS_VIDEO_BITRATE=12000
    ;;
  *)
    echo "error: output-profile must be 1080p30 or 1080p60." >&2
    exit 1
    ;;
esac
EGRESS_AUDIO_BITRATE=128
EGRESS_AUDIO_FREQUENCY=48000

load_env
require_livekit_env
find_lk
for command in docker flock jq stat; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "error: $command is required for output conformance." >&2
    exit 1
  }
done
if command -v sha256sum >/dev/null 2>&1; then
  SHA256_COMMAND=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA256_COMMAND=(shasum -a 256)
else
  echo "error: sha256sum or shasum is required for output conformance." >&2
  exit 1
fi
: "${PROGRAM_PAGE_BASE_URL:?set PROGRAM_PAGE_BASE_URL in .env}"
: "${PROGRAM_PAGE_TOKEN:?set PROGRAM_PAGE_TOKEN in .env}"
: "${PROGRAM_RENDERER_GIT_SHA:?set PROGRAM_RENDERER_GIT_SHA in .env}"
: "${PROGRAM_RENDERER_DEPLOYMENT_ID:?set PROGRAM_RENDERER_DEPLOYMENT_ID in .env}"
if ! [[ "$PROGRAM_PAGE_BASE_URL" =~ ^https://[a-z0-9-]+\.vercel\.app/program$ ]]; then
  echo "error: PROGRAM_PAGE_BASE_URL must use the immutable generated Vercel deployment URL ending in /program." >&2
  exit 1
fi
if ! [[ "$PROGRAM_RENDERER_GIT_SHA" =~ ^[a-f0-9]{40}$ ]] || ! [[ "$PROGRAM_RENDERER_DEPLOYMENT_ID" =~ ^dpl_[A-Za-z0-9]+$ ]]; then
  echo "error: renderer identity is invalid." >&2
  exit 1
fi

REQ_DIR="$COMPOSITOR_DIR/requests"
HOST_OUTPUT_DIR="$COMPOSITOR_DIR/evidence/$EVIDENCE_ID"
CONTAINER_OUTPUT_DIR="/out/$EVIDENCE_ID"
OUTPUT_NAME="court-${COURT}-${OUTPUT_PROFILE}.mp4"
HOST_OUTPUT="$HOST_OUTPUT_DIR/$OUTPUT_NAME"
CONTAINER_OUTPUT="$CONTAINER_OUTPUT_DIR/$OUTPUT_NAME"
REPORT="$HOST_OUTPUT_DIR/court-${COURT}-${OUTPUT_PROFILE}.capture.json"
mkdir -p "$REQ_DIR"
install -d -m 0770 "$COMPOSITOR_DIR/evidence" "$HOST_OUTPUT_DIR"

exec 9>"$REQ_DIR/start.lock"
flock -n 9 || {
  echo "error: another Egress start is already in progress." >&2
  exit 1
}

if [[ -f "$REPORT" ]]; then
  [[ -f "$HOST_OUTPUT" ]] || {
    echo "error: conformance report exists without its sample." >&2
    exit 1
  }
  cat "$REPORT"
  exit 0
fi
if [[ -e "$HOST_OUTPUT" ]]; then
  echo "error: incomplete conformance sample exists without a report; preserve and inspect it before retrying." >&2
  exit 1
fi

ACTIVE_FILE="$(mktemp "$REQ_DIR/.active-egress.XXXXXX")"
START_LOG="$(mktemp "$REQ_DIR/.conformance-start.XXXXXX")"
STOP_LOG="$(mktemp "$REQ_DIR/.conformance-stop.XXXXXX")"
REQ_FILE="$(mktemp "$REQ_DIR/.conformance-request.XXXXXX")"
EGRESS_ID=""
stopped=0
START_ATTEMPTS=0
STARTING_STALLS=0
ATTEMPTS_JSON='[]'

refresh_active() {
  "$LK" egress list --active --json >"$ACTIVE_FILE" 2>/dev/null || return 1
  jq -e '(. == null) or (type == "array" and all(.[]; (.egress_id | type) == "string"))' "$ACTIVE_FILE" >/dev/null 2>&1
}

active_count() {
  jq -er 'if . == null then 0 else length end' "$ACTIVE_FILE"
}

restart_egress_for_cleanup() {
  local id="$1"
  if compgen -G "$REQ_DIR/court-*.owner.json" >/dev/null; then
    echo "error: refusing conformance cleanup restart while a production Egress owner exists." >&2
    return 1
  fi
  if ! refresh_active || [[ "$(active_count)" != 1 ]] || ! jq -e --arg id "$id" 'type == "array" and .[0].egress_id == $id' "$ACTIVE_FILE" >/dev/null 2>&1; then
    echo "error: refusing conformance cleanup restart without one exact ownerless Egress." >&2
    return 1
  fi
  if ! docker restart bvm-egress >/dev/null 2>&1; then
    echo "error: isolated Egress-container cleanup restart failed." >&2
    return 1
  fi
  for _ in $(seq 1 90); do
    if [[ "$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" == healthy ]] \
      && refresh_active && [[ "$(active_count)" == 0 ]]; then
      echo "warning: isolated Egress container restarted to clear the exact stuck conformance job ${id}." >&2
      return 0
    fi
    sleep 1
  done
  echo "error: isolated Egress-container cleanup restart did not return healthy and idle." >&2
  return 1
}

stop_and_prove_idle() {
  local id="$1"
  if ! refresh_active; then
    echo "error: could not verify active Egress state before conformance cleanup." >&2
    return 1
  fi
  local count
  count="$(active_count)"
  if (( count == 0 )); then
    return 0
  fi
  if ! jq -e --arg id "$id" 'type == "array" and any(.[]; .egress_id == $id)' "$ACTIVE_FILE" >/dev/null 2>&1; then
    echo "error: an unexpected Egress replaced the conformance job during cleanup." >&2
    return 1
  fi
  if ! "$LK" egress stop --id "$id" >>"$STOP_LOG" 2>&1; then
    if refresh_active && (( $(active_count) == 0 )); then
      return 0
    fi
    if restart_egress_for_cleanup "$id"; then
      echo "error: exact conformance stop timed out; cleanup recovered but qualification is invalid." >&2
      return 1
    fi
    echo "error: output-conformance Egress did not accept the exact stop request." >&2
    return 1
  fi
  for _ in $(seq 1 60); do
    if refresh_active; then
      count="$(active_count)"
      if (( count == 0 )); then
        return 0
      fi
      if ! jq -e --arg id "$id" 'type == "array" and any(.[]; .egress_id == $id)' "$ACTIVE_FILE" >/dev/null 2>&1; then
        echo "error: an unexpected Egress remained after conformance cleanup." >&2
        return 1
      fi
    fi
    sleep 1
  done
  echo "error: compositor did not return to idle after output conformance." >&2
  return 1
}

cleanup() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT
  set +e
  if [[ -n "$EGRESS_ID" && "$stopped" -eq 0 ]]; then
    stop_and_prove_idle "$EGRESS_ID" || cleanup_status=1
  fi
  rm -f "$ACTIVE_FILE" "$START_LOG" "$STOP_LOG" "$REQ_FILE"
  if (( cleanup_status != 0 )); then
    echo "error: output-conformance cleanup could not prove the compositor idle." >&2
    exit 1
  fi
  exit "$original_status"
}
trap cleanup EXIT

if ! refresh_active; then
  echo "error: could not verify active Egress count." >&2
  exit 1
fi
if ! ACTIVE_COUNT="$(active_count)" || (( ACTIVE_COUNT != 0 )); then
  echo "error: compositor is not idle before output conformance." >&2
  exit 1
fi

PROGRAM_TOKEN_FRAGMENT="$(printf '%s' "$PROGRAM_PAGE_TOKEN" | jq -sRr @uri)"
PAGE_URL="${PROGRAM_PAGE_BASE_URL}/bootstrap?court=${COURT}&build=${PROGRAM_RENDERER_GIT_SHA}&deployment=${PROGRAM_RENDERER_DEPLOYMENT_ID}#token=${PROGRAM_TOKEN_FRAGMENT}"
cat >"$REQ_FILE" <<EOF
{
  "url": "${PAGE_URL}",
  "audio_only": false,
  "video_only": false,
  "await_start_signal": true,
  "advanced": {
    "width": 1920,
    "height": 1080,
    "framerate": ${EGRESS_FRAMERATE},
    "audio_codec": "AAC",
    "audio_bitrate": ${EGRESS_AUDIO_BITRATE},
    "audio_frequency": ${EGRESS_AUDIO_FREQUENCY},
    "video_codec": "H264_HIGH",
    "video_bitrate": ${EGRESS_VIDEO_BITRATE},
    "key_frame_interval": 2
  },
  "file_outputs": [{
    "file_type": "MP4",
    "filepath": "${CONTAINER_OUTPUT}",
    "disable_manifest": true
  }]
}
EOF
chmod 600 "$REQ_FILE"

active_seen=0
for attempt in 1 2; do
  START_ATTEMPTS="$attempt"
  : >"$START_LOG"
  if ! "$LK" egress start --type web "$REQ_FILE" >"$START_LOG" 2>&1; then
    echo "error: output-conformance Egress did not start on attempt ${attempt}." >&2
    exit 1
  fi
  EGRESS_ID="$(grep -oE 'EG_[A-Za-z0-9]+' "$START_LOG" | head -n1 || true)"
  if ! [[ "$EGRESS_ID" =~ ^EG_[A-Za-z0-9]+$ ]]; then
    echo "error: output-conformance Egress id is invalid on attempt ${attempt}." >&2
    exit 1
  fi
  stopped=0

  for _ in $(seq 1 60); do
    if refresh_active && jq -e --arg id "$EGRESS_ID" 'type == "array" and any(.[]; .egress_id == $id and .status == 1)' "$ACTIVE_FILE" >/dev/null 2>&1; then
      active_seen=1
      break
    fi
    sleep 1
  done
  if (( active_seen == 1 )); then
    ATTEMPTS_JSON="$(jq -cn --argjson attempts "$ATTEMPTS_JSON" --argjson number "$attempt" --arg id "$EGRESS_ID" --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '$attempts + [{number:$number,egressId:$id,outcome:"ACTIVE",observedAt:$observedAt}]')"
    break
  fi

  if ! refresh_active; then
    echo "error: could not classify output-conformance Egress attempt ${attempt}." >&2
    exit 1
  fi
  if ! jq -e --arg id "$EGRESS_ID" 'type == "array" and any(.[]; .egress_id == $id)' "$ACTIVE_FILE" >/dev/null 2>&1; then
    ATTEMPTS_JSON="$(jq -cn --argjson attempts "$ATTEMPTS_JSON" --argjson number "$attempt" --arg id "$EGRESS_ID" --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '$attempts + [{number:$number,egressId:$id,outcome:"EXITED_BEFORE_ACTIVE",observedAt:$observedAt}]')"
    echo "error: output-conformance Egress exited before becoming active on attempt ${attempt}." >&2
    exit 1
  fi

  STARTING_STALLS=$((STARTING_STALLS + 1))
  ATTEMPTS_JSON="$(jq -cn --argjson attempts "$ATTEMPTS_JSON" --argjson number "$attempt" --arg id "$EGRESS_ID" --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '$attempts + [{number:$number,egressId:$id,outcome:"STARTING_TIMEOUT",observedAt:$observedAt}]')"
  echo "warning: output-conformance Egress attempt ${attempt} remained STARTING; stopping the exact job before retry." >&2
  if ! stop_and_prove_idle "$EGRESS_ID"; then
    exit 1
  fi
  stopped=1
  if [[ -e "$HOST_OUTPUT" ]]; then
    mv "$HOST_OUTPUT" "$HOST_OUTPUT_DIR/court-${COURT}-${OUTPUT_PROFILE}.attempt-${attempt}-starting-timeout.mp4"
  fi
  if (( attempt == 2 )); then
    echo "error: output-conformance Egress remained STARTING on both bounded attempts." >&2
    exit 1
  fi
  EGRESS_ID=""
  stopped=0
done

if (( active_seen != 1 )); then
  echo "error: output-conformance Egress did not become active." >&2
  exit 1
fi

sleep 20
if ! stop_and_prove_idle "$EGRESS_ID"; then
  exit 1
fi
stopped=1

for _ in $(seq 1 30); do
  [[ -s "$HOST_OUTPUT" ]] && break
  sleep 1
done
if [[ ! -s "$HOST_OUTPUT" ]]; then
  echo "error: output-conformance sample was not finalized." >&2
  exit 1
fi
chmod 600 "$HOST_OUTPUT"
FILE_SHA256="$("${SHA256_COMMAND[@]}" "$HOST_OUTPUT" | awk '{print $1}')"
FILE_SIZE="$(stat -c '%s' "$HOST_OUTPUT" 2>/dev/null || stat -f '%z' "$HOST_OUTPUT")"
CAPTURED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
jq -n \
  --arg evidenceId "$EVIDENCE_ID" \
  --arg capturedAt "$CAPTURED_AT" \
  --arg egressId "$EGRESS_ID" \
  --arg profile "$OUTPUT_PROFILE" \
  --arg rendererGitSha "$PROGRAM_RENDERER_GIT_SHA" \
  --arg rendererDeploymentId "$PROGRAM_RENDERER_DEPLOYMENT_ID" \
  --arg remotePath "$HOST_OUTPUT" \
  --arg sha256 "$FILE_SHA256" \
  --argjson court "$COURT" \
  --argjson width 1920 \
  --argjson height 1080 \
  --argjson framesPerSecond "$EGRESS_FRAMERATE" \
  --argjson audioTargetBitrateKbps "$EGRESS_AUDIO_BITRATE" \
  --argjson audioSampleRateHz "$EGRESS_AUDIO_FREQUENCY" \
  --argjson videoTargetBitrateKbps "$EGRESS_VIDEO_BITRATE" \
  --argjson keyFrameIntervalSeconds 2 \
  --argjson startAttempts "$START_ATTEMPTS" \
  --argjson recoveredStartingStall "$([[ "$STARTING_STALLS" -gt 0 ]] && printf true || printf false)" \
  --argjson attempts "$ATTEMPTS_JSON" \
  --argjson sizeBytes "$FILE_SIZE" \
  '{schemaVersion:1,evidenceId:$evidenceId,capturedAt:$capturedAt,court:$court,profile:$profile,egressId:$egressId,renderer:{gitSha:$rendererGitSha,deploymentId:$rendererDeploymentId},encoding:{width:$width,height:$height,framesPerSecond:$framesPerSecond,audioCodec:"AAC",audioTargetBitrateKbps:$audioTargetBitrateKbps,audioSampleRateHz:$audioSampleRateHz,videoCodec:"H264_HIGH",videoTargetBitrateKbps:$videoTargetBitrateKbps,keyFrameIntervalSeconds:$keyFrameIntervalSeconds},startup:{startAttempts:$startAttempts,recoveredStartingStall:$recoveredStartingStall,attempts:$attempts},remotePath:$remotePath,sha256:$sha256,sizeBytes:$sizeBytes}' >"$REPORT"
chmod 600 "$REPORT"
cat "$REPORT"
