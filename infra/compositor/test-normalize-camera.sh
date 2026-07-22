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

printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$@" >"$NORMALIZER_ARGUMENT_CAPTURE"' >"$TEST_ROOT/fake-ffmpeg"
chmod 0755 "$TEST_ROOT/fake-ffmpeg"

export CAMERA_NORMALIZER_ENABLED=true
export CAMERA_SOURCE_PATH_MODE=isolated-hevc-normalizer
export CAMERA_SOURCE_CODEC=H265
export CAMERA_NUMBER=2
export CAMERA_NORMALIZER_INPUT_PATH=court2_raw
export CAMERA_NORMALIZER_OUTPUT_PATH=court2_normalized
export CAMERA_SOURCE_PROFILE=STANDARD_1080P30
export CAMERA_FRAME_RATE_MODE=30000/1001
export MEDIAMTX_PRIVATE_HOST=10.20.0.3
export NORMALIZER_FFMPEG_BIN="$TEST_ROOT/fake-ffmpeg"
export NORMALIZER_ARGUMENT_CAPTURE="$CAPTURE"
export NORMALIZER_PROGRESS_DIR="$TEST_ROOT"

sh "$NORMALIZER"
grep -Fxq 'rtsp://10.20.0.3:8554/court2_raw' "$CAPTURE" || fail "normalizer did not use the private raw input"
grep -Fxq 'rtsp://10.20.0.3:8554/court2_normalized' "$CAPTURE" || fail "normalizer did not publish the private normalized output"
grep -Fxq 'libx264' "$CAPTURE" || fail "normalizer did not encode H264"
grep -Fxq 'high' "$CAPTURE" || fail "normalizer did not select H264 High profile"
grep -Fxq '30000/1001' "$CAPTURE" || fail "normalizer did not preserve 29.97 fps mode"
grep -Fxq '10000k' "$CAPTURE" || fail "normalizer did not apply the 1080p30 bitrate"
grep -Fxq 'libopus' "$CAPTURE" || fail "normalizer did not produce browser-safe Opus audio"
grep -Fq 'bframes=0:keyint=60:min-keyint=60:scenecut=0' "$CAPTURE" || fail "normalizer did not enforce the browser GOP contract"

export CAMERA_SOURCE_PROFILE=PRIORITY_1080P60
export CAMERA_FRAME_RATE_MODE=60000/1001
sh "$NORMALIZER"
grep -Fxq '60000/1001' "$CAPTURE" || fail "normalizer did not preserve 59.94 fps mode"
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

grep -Fq 'profiles: ["hevc-normalizer"]' "$COMPOSE" || fail "normalizer is not profile scoped"
grep -Fq 'network_mode: host' "$COMPOSE" || fail "normalizer cannot use the private host route"
grep -Fq 'COMPOSITOR_INGEST_PRIVATE_IP' "$DEPLOY" || fail "deployment does not bind the ingest private IPv4"
grep -Fq 'COMPOSITOR_INGEST_HOST' "$DEPLOY" || fail "deployment does not bind the ingest TLS hostname"
grep -Fq 'for optional in normalize-camera.sh rebind-ingest.sh start-normalizer.sh stop-normalizer.sh' "$DEPLOY" \
  || fail "deployment does not treat the new recovery helper as optional in legacy backups"
grep -Fq 'extra_hosts:' "$COMPOSE" || fail "Egress does not route the ingest TLS hostname over the VPC"
grep -Fq 'MEDIAMTX_PUBLIC_HOST' "$COMPOSE" || fail "Egress VPC binding omits the ingest TLS hostname"

printf 'PASS: isolated HEVC normalization is private, profile-scoped, and browser-safe\n'
