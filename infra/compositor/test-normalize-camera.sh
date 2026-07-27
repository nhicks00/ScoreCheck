#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
NORMALIZER="$SCRIPT_DIR/normalize-camera.sh"
COMPOSE="$SCRIPT_DIR/docker-compose.yml"
DEPLOY="$SCRIPT_DIR/deploy.sh"
TEST_ROOT="$(mktemp -d)"
CAPTURE="$TEST_ROOT/arguments"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

cat >"$TEST_ROOT/fake-runner" <<'EOF'
#!/bin/sh
[ "$1" = "court${CAMERA_NUMBER}_normalizer" ] || exit 64
shift
[ "$1" = "--" ] || exit 64
shift
printf '%s\n' "$@" >"$NORMALIZER_ARGUMENT_CAPTURE"
EOF
chmod 0755 "$TEST_ROOT/fake-runner"

export CAMERA_NORMALIZER_ENABLED=true
export CAMERA_SOURCE_PATH_MODE=isolated-browser-normalizer
export CAMERA_SOURCE_CODEC=H265
export CAMERA_NUMBER=2
export CAMERA_NORMALIZER_INPUT_PATH=court2_raw
export CAMERA_NORMALIZER_OUTPUT_PATH=court2_normalized
export CAMERA_SOURCE_PROFILE=STANDARD_1080P30
export CAMERA_FRAME_RATE_MODE=30000/1001
export MEDIAMTX_PRIVATE_HOST=10.20.0.3
export NORMALIZER_FFMPEG_RUNNER="$TEST_ROOT/fake-runner"
export NORMALIZER_ARGUMENT_CAPTURE="$CAPTURE"
export NORMALIZER_PROGRESS_DIR="$TEST_ROOT"

sh "$NORMALIZER"
grep -Fxq 'rtsp://10.20.0.3:8554/court2_raw' "$CAPTURE" || fail "normalizer did not use the private raw input"
grep -Fxq 'rtsp://10.20.0.3:8554/court2_normalized' "$CAPTURE" || fail "normalizer did not publish the private normalized output"
grep -Fxq 'libx264' "$CAPTURE" || fail "normalizer did not encode H264"
grep -Fxq 'high' "$CAPTURE" || fail "normalizer did not select H264 High profile"
grep -Fq 'setpts=N/(30000/1001*TB)' "$CAPTURE" || fail "normalizer did not preserve 29.97 fps mode"
grep -Fxq '10000k' "$CAPTURE" || fail "normalizer did not apply the 1080p30 bitrate"
grep -Fxq 'aac' "$CAPTURE" || fail "normalizer did not produce MPEG-TS-safe transport audio"
if grep -Fxq 'libopus' "$CAPTURE"; then
  fail "normalizer retained nonstandard Opus-over-MPEG-TS transport audio"
fi
grep -Fq 'bframes=0:keyint=60:min-keyint=60:scenecut=0' "$CAPTURE" || fail "normalizer did not enforce the browser GOP contract"
grep -Fq 'setpts=N/(30000/1001*TB),format=yuv420p,setfield=prog' "$CAPTURE" || fail "normalizer did not replace defective source video timestamps"
grep -Fq 'asetpts=N/SR/TB,aresample=async=1:first_pts=0' "$CAPTURE" || fail "normalizer did not replace defective source audio timestamps"
grep -Fxq 'passthrough' "$CAPTURE" || fail "normalizer can still duplicate frames to catch up"
if grep -Fxq 'cfr' "$CAPTURE"; then
  fail "normalizer still applies timestamp-driven CFR duplication"
fi
readrate_line=$(grep -nFx -- '-readrate' "$CAPTURE" | cut -d: -f1)
input_line=$(grep -nFx -- '-i' "$CAPTURE" | cut -d: -f1)
[ -n "$readrate_line" ] && [ "$readrate_line" -lt "$input_line" ] \
  || fail "normalizer does not pace bursty hardware input before decoding"
[ "$(sed -n "$((readrate_line + 1))p" "$CAPTURE")" = "1" ] \
  || fail "normalizer does not read input at real-time cadence"
if grep -Fxq -- '-copyts' "$CAPTURE" || grep -Fxq -- '-use_wallclock_as_timestamps' "$CAPTURE"; then
  fail "normalizer overrides MediaMTX timestamp mapping"
fi
if grep -Fxq 'low_delay' "$CAPTURE"; then
  fail "normalizer forced low-delay decoding on an HEVC source with reference-frame reordering"
fi

export CAMERA_SOURCE_CODEC=H264
sh "$NORMALIZER"
grep -Fxq 'libx264' "$CAPTURE" || fail "normalizer did not accept unsafe H264 input"
grep -Fxq -- '-readrate' "$CAPTURE" || fail "unsafe H264 normalization does not pace bursty input"
export CAMERA_SOURCE_CODEC=H265

export CAMERA_SOURCE_PROFILE=PRIORITY_1080P60
export CAMERA_FRAME_RATE_MODE=60000/1001
sh "$NORMALIZER"
grep -Fq 'setpts=N/(60000/1001*TB)' "$CAPTURE" || fail "normalizer did not preserve 59.94 fps mode"
grep -Fxq '12000k' "$CAPTURE" || fail "normalizer did not apply the 1080p60 bitrate"
grep -Fq 'bframes=0:keyint=120:min-keyint=120:scenecut=0' "$CAPTURE" || fail "normalizer did not apply the 60 fps GOP"

export MEDIAMTX_PRIVATE_HOST=198.51.100.10
if sh "$NORMALIZER" >/dev/null 2>&1; then
  fail "normalizer accepted a public ingest address"
fi
export MEDIAMTX_PRIVATE_HOST=10.20.0.3
export CAMERA_SOURCE_PATH_MODE=direct-h264
if sh "$NORMALIZER" >/dev/null 2>&1; then
  fail "normalizer accepted a direct-H264 assignment"
fi

grep -Fq 'profiles: ["browser-normalizer"]' "$COMPOSE" || fail "normalizer is not profile scoped"
grep -Fq 'network_mode: host' "$COMPOSE" || fail "normalizer cannot use the private host route"
grep -Fq 'entrypoint: ["/usr/local/bin/normalize-camera"]' "$COMPOSE" \
  || fail "normalizer does not override the MediaMTX image entrypoint"
grep -Fq './scorecheck-ffmpeg-runner.sh:/usr/local/bin/scorecheck-ffmpeg-runner:ro' "$COMPOSE" \
  || fail "normalizer does not mount the bounded FFmpeg progress runner"
grep -Fq 'COMPOSITOR_INGEST_PRIVATE_IP' "$DEPLOY" || fail "deployment does not bind the ingest private IPv4"
grep -Fq 'COMPOSITOR_INGEST_HOST' "$DEPLOY" || fail "deployment does not bind the ingest TLS hostname"
grep -Fq 'for optional in normalize-camera.sh scorecheck-ffmpeg-runner.sh rebind-ingest.sh start-normalizer.sh stop-normalizer.sh' "$DEPLOY" \
  || fail "deployment does not treat the new recovery helper as optional in legacy backups"
grep -Fq 'extra_hosts:' "$COMPOSE" || fail "Egress does not route the ingest TLS hostname over the VPC"
grep -Fq 'MEDIAMTX_PUBLIC_HOST' "$COMPOSE" || fail "Egress VPC binding omits the ingest TLS hostname"

printf 'PASS: isolated browser normalization is private, profile-scoped, and browser-safe\n'
