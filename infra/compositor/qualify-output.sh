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
FFPROBE_IMAGE="bluenviron/mediamtx:1.19.2-ffmpeg@sha256:08c837deb7bac85d509e2a4c2737308e5a34f8f084a46a0d8793cdb0579a6e5d"

load_env
require_livekit_env
find_lk
for command in curl docker flock jq stat; do
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
: "${PROGRAM_RENDERER_RELEASE_ORIGIN:?set PROGRAM_RENDERER_RELEASE_ORIGIN in .env}"
: "${PROGRAM_RENDERER_BUNDLE_SHA256:?set PROGRAM_RENDERER_BUNDLE_SHA256 in .env}"
: "${PROGRAM_RENDERER_GIT_SHA:?set PROGRAM_RENDERER_GIT_SHA in .env}"
: "${PROGRAM_RENDERER_DEPLOYMENT_ID:?set PROGRAM_RENDERER_DEPLOYMENT_ID in .env}"
if [[ "$PROGRAM_PAGE_BASE_URL" != "http://renderer:3000/program" ]]; then
  echo "error: PROGRAM_PAGE_BASE_URL must use the event-local renderer service." >&2
  exit 1
fi
if ! [[ "$PROGRAM_RENDERER_RELEASE_ORIGIN" =~ ^https://[a-z0-9-]+\.vercel\.app$ ]] \
  || ! [[ "$PROGRAM_RENDERER_BUNDLE_SHA256" =~ ^[a-f0-9]{64}$ ]] \
  || ! [[ "$PROGRAM_RENDERER_GIT_SHA" =~ ^[a-f0-9]{40}$ ]] \
  || ! [[ "$PROGRAM_RENDERER_DEPLOYMENT_ID" =~ ^dpl_[A-Za-z0-9]+$ ]]; then
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
PROBE_REPORT="$HOST_OUTPUT_DIR/court-${COURT}-${OUTPUT_PROFILE}.ffprobe.json"
PROBE_SUMMARY="$HOST_OUTPUT_DIR/court-${COURT}-${OUTPUT_PROFILE}.conformance.json"
mkdir -p "$REQ_DIR"
install -d -m 0770 "$COMPOSITOR_DIR/evidence" "$HOST_OUTPUT_DIR"

exec 9>"$REQ_DIR/start.lock"
flock -w 10 9 || {
  echo "error: Egress admission did not become idle within ten seconds." >&2
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
RENDERER_BINDING_FILE="$(mktemp "$REQ_DIR/.renderer-binding.XXXXXX")"
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

reset_egress_control_stack_for_cleanup() {
  local id="$1"
  if compgen -G "$REQ_DIR/court-*.owner.json" >/dev/null; then
    echo "error: refusing conformance cleanup restart while a production Egress owner exists." >&2
    return 1
  fi
  if ! refresh_active || [[ "$(active_count)" != 1 ]] || ! jq -e --arg id "$id" 'type == "array" and .[0].egress_id == $id' "$ACTIVE_FILE" >/dev/null 2>&1; then
    echo "error: refusing conformance cleanup restart without one exact ownerless Egress." >&2
    return 1
  fi
  if ! docker restart bvm-redis >/dev/null 2>&1; then
    echo "error: isolated Egress Redis cleanup restart failed." >&2
    return 1
  fi
  for _ in $(seq 1 60); do
    [[ "$(docker inspect bvm-redis --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" == healthy ]] && break
    sleep 1
  done
  if [[ "$(docker inspect bvm-redis --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" != healthy ]]; then
    echo "error: isolated Egress Redis did not return healthy during cleanup." >&2
    return 1
  fi
  if ! docker restart bvm-livekit bvm-egress >/dev/null 2>&1; then
    echo "error: isolated Egress control/worker cleanup restart failed." >&2
    return 1
  fi
  for _ in $(seq 1 90); do
    if [[ "$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" == healthy ]] \
      && [[ "$(docker inspect bvm-livekit --format '{{.State.Running}}' 2>/dev/null || true)" == true ]] \
      && refresh_active && [[ "$(active_count)" == 0 ]]; then
      echo "warning: isolated Egress control stack restarted to clear the exact stuck conformance job ${id}." >&2
      return 0
    fi
    sleep 1
  done
  echo "error: isolated Egress control-stack cleanup restart did not return healthy and idle." >&2
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
    if reset_egress_control_stack_for_cleanup "$id"; then
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
  if reset_egress_control_stack_for_cleanup "$id"; then
    echo "error: exact conformance stop did not reach idle; cleanup recovered but qualification is invalid." >&2
    return 1
  fi
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
  rm -f "$ACTIVE_FILE" "$START_LOG" "$STOP_LOG" "$REQ_FILE" "$RENDERER_BINDING_FILE"
  if (( cleanup_status != 0 )); then
    echo "error: output-conformance cleanup could not prove the compositor idle." >&2
    exit 1
  fi
  exit "$original_status"
}
trap cleanup EXIT

if ! curl -fsS --max-time 5 http://127.0.0.1:3000/api/program/renderer-binding >"$RENDERER_BINDING_FILE" \
  || ! jq -e \
    --arg origin "$PROGRAM_RENDERER_RELEASE_ORIGIN" \
    --arg gitSha "$PROGRAM_RENDERER_GIT_SHA" \
    --arg deploymentId "$PROGRAM_RENDERER_DEPLOYMENT_ID" '
      .schemaVersion == 1
      and .provider == "vercel"
      and .origin == $origin
      and .gitSha == $gitSha
      and .deploymentId == $deploymentId
      and .assetNamespace == $deploymentId
      and .contracts.programSession == "program-session-v1"
      and .contracts.overlayState == "overlay-state-v1"
      and .contracts.commentary == "commentary-v1"
      and .contracts.browserHeartbeat == "browser-heartbeat-v6"
    ' "$RENDERER_BINDING_FILE" >/dev/null; then
  echo "error: event-local renderer binding does not match the admitted artifact." >&2
  exit 1
fi

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
  "await_start_signal": false,
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
chmod 640 "$HOST_OUTPUT"
if ! docker run --rm --network none --read-only --user 0:0 --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$HOST_OUTPUT_DIR:/evidence:ro" \
  --entrypoint ffprobe "$FFPROBE_IMAGE" \
  -v error -print_format json \
  -show_entries 'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,field_order,color_space,color_transfer,color_primaries,avg_frame_rate,bit_rate,sample_rate,channels:format=duration,bit_rate:frame=stream_index,key_frame,best_effort_timestamp_time' \
  -show_streams -show_format -show_frames "/evidence/$OUTPUT_NAME" >"$PROBE_REPORT"; then
  chmod 600 "$HOST_OUTPUT"
  echo "error: actual output sample could not be inspected." >&2
  exit 1
fi
chmod 600 "$HOST_OUTPUT"
chmod 600 "$PROBE_REPORT"
# LiveKit FileOutput MP4 bitrate is content-dependent. Enforce positive bounded
# output here; production RTMP CBR is verified by the provider gate.
if ! jq -e \
  --argjson expectedFps "$EGRESS_FRAMERATE" \
  --argjson targetVideoKbps "$EGRESS_VIDEO_BITRATE" '
    def ratio:
      split("/") as $parts
      | ($parts[0] | tonumber) / ($parts[1] | tonumber);
    (.streams | map(select(.codec_type == "video"))) as $videos
    | (.streams | map(select(.codec_type == "audio"))) as $audios
    | ($videos[0]) as $video
    | ($audios[0]) as $audio
    | ([.frames[]? | select(.stream_index == $video.index and .key_frame == 1) | .best_effort_timestamp_time | tonumber]) as $keyframes
    | ([range(1; $keyframes | length) | $keyframes[.] - $keyframes[.-1]]) as $keyframeGaps
    | {
        videoCodec: $video.codec_name,
        videoProfile: $video.profile,
        width: $video.width,
        height: $video.height,
        pixelFormat: $video.pix_fmt,
        fieldOrder: $video.field_order,
        colorSpace: $video.color_space,
        colorTransfer: $video.color_transfer,
        colorPrimaries: $video.color_primaries,
        framesPerSecond: ($video.avg_frame_rate | ratio),
        videoBitrateKbps: (($video.bit_rate | tonumber) / 1000),
        audioCodec: $audio.codec_name,
        audioChannels: $audio.channels,
        audioSampleRateHz: ($audio.sample_rate | tonumber),
        audioBitrateKbps: (($audio.bit_rate | tonumber) / 1000),
        durationSeconds: (.format.duration | tonumber),
        keyFrameCount: ($keyframes | length),
        maximumKeyFrameGapSeconds: ($keyframeGaps | max // 0)
      }
    | . as $summary
    | if ($videos | length) != 1 or ($audios | length) != 1
        or .videoCodec != "h264" or .videoProfile != "High"
        or .width != 1920 or .height != 1080
        or .pixelFormat != "yuv420p" or .fieldOrder != "progressive"
        or .colorSpace != "bt709" or .colorTransfer != "bt709" or .colorPrimaries != "bt709"
        or ((.framesPerSecond - $expectedFps) | fabs) > 0.5
        or .videoBitrateKbps <= 0 or .videoBitrateKbps > ($targetVideoKbps * 1.25)
        or .audioCodec != "aac" or .audioChannels != 2 or .audioSampleRateHz != 48000
        or .audioBitrateKbps <= 0 or .audioBitrateKbps > 192
        or .durationSeconds < 15
        or .keyFrameCount < 5 or .maximumKeyFrameGapSeconds > 2.25
      then error("actual output does not satisfy the 1080p YouTube conformance contract")
      else $summary end
  ' "$PROBE_REPORT" >"$PROBE_SUMMARY"; then
  chmod 600 "$PROBE_SUMMARY" 2>/dev/null || true
  echo "error: actual output sample failed conformance; preserve the ffprobe evidence." >&2
  exit 1
fi
chmod 600 "$PROBE_SUMMARY"
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
  --slurpfile actual "$PROBE_SUMMARY" \
  '{schemaVersion:2,evidenceId:$evidenceId,capturedAt:$capturedAt,court:$court,profile:$profile,egressId:$egressId,renderer:{gitSha:$rendererGitSha,deploymentId:$rendererDeploymentId},requestedEncoding:{width:$width,height:$height,framesPerSecond:$framesPerSecond,audioCodec:"AAC",audioTargetBitrateKbps:$audioTargetBitrateKbps,audioSampleRateHz:$audioSampleRateHz,videoCodec:"H264_HIGH",videoTargetBitrateKbps:$videoTargetBitrateKbps,keyFrameIntervalSeconds:$keyFrameIntervalSeconds},actualEncoding:$actual[0],startup:{startAttempts:$startAttempts,recoveredStartingStall:$recoveredStartingStall,attempts:$attempts},remotePath:$remotePath,sha256:$sha256,sizeBytes:$sizeBytes}' >"$REPORT"
chmod 600 "$REPORT"
cat "$REPORT"
