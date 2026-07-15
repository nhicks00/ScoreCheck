#!/usr/bin/env bash

set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKERFILE="$SCRIPT_DIR/Dockerfile.test-feed"
SOURCE_FILE="$SCRIPT_DIR/run-test-feed-fault.mjs"
DOCKERIGNORE="$SCRIPT_DIR/.dockerignore"

usage() {
  cat <<'USAGE'
Usage: run-test-feed-container.sh --court 2..5 \
  --scenario freeze|black|camera-silence|publisher-loss \
  --output /absolute/protected-evidence.jsonl [--api-base HTTPS_URL]

Runs the test-feed controller in a locked-down, SRT/RTMP-capable container.
Required secrets stay in the caller environment and are forwarded by variable
name; values are never placed in command arguments or an env file.
USAGE
}

command -v docker >/dev/null 2>&1 || { echo "error: docker is required" >&2; exit 1; }
command -v shasum >/dev/null 2>&1 || { echo "error: shasum is required" >&2; exit 1; }
[[ -f "$DOCKERFILE" && -f "$SOURCE_FILE" && -f "$DOCKERIGNORE" ]] || { echo "error: test-feed runner sources are incomplete" >&2; exit 1; }

court=""
output=""
forwarded=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --court)
      [[ $# -ge 2 ]] || { echo "error: --court requires a value" >&2; exit 1; }
      court="$2"
      forwarded+=("$1" "$2")
      shift 2
      ;;
    --output)
      [[ $# -ge 2 ]] || { echo "error: --output requires a value" >&2; exit 1; }
      output="$2"
      shift 2
      ;;
    --ffmpeg)
      echo "error: --ffmpeg cannot override the pinned container executable" >&2
      exit 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      forwarded+=("$1")
      shift
      ;;
  esac
done

[[ "$court" =~ ^[2-5]$ ]] || { echo "error: --court must select Camera 2-5" >&2; exit 1; }
[[ "$output" = /* ]] || { echo "error: --output must be absolute" >&2; exit 1; }
output_name="$(basename "$output")"
[[ "$output_name" =~ ^[a-zA-Z0-9._-]+\.jsonl$ ]] || { echo "error: output filename must be a safe .jsonl name" >&2; exit 1; }
[[ ! -e "$output" ]] || { echo "error: output already exists: $output" >&2; exit 1; }
output_dir="$(dirname "$output")"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd -P)"
run_dir="$(mktemp -d "$output_dir/.scorecheck-test-feed.XXXXXX")"
chmod 0700 "$run_dir"
cleanup() {
  rm -rf "$run_dir"
}
signal_status=0
trap cleanup EXIT
trap 'signal_status=130' INT
trap 'signal_status=143' TERM
forwarded+=("--output" "/evidence/$output_name")

required=(
  MONITOR_API_TOKEN
  MEDIAMTX_PUBLIC_HOST
  "MEDIAMTX_COURT_${court}_PUBLISH_USER"
  "MEDIAMTX_COURT_${court}_PUBLISH_PASS"
)
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || { echo "error: $name is required" >&2; exit 1; }
done

source_sha="$(cd "$SCRIPT_DIR" && shasum -a 256 Dockerfile.test-feed run-test-feed-fault.mjs .dockerignore | shasum -a 256 | awk '{print $1}')"
image="scorecheck-test-feed:${source_sha:0:16}"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  docker build \
    --file "$DOCKERFILE" \
    --build-arg "SCORECHECK_TEST_FEED_SOURCE_SHA=$source_sha" \
    --tag "$image" \
    "$SCRIPT_DIR"
fi
actual_sha="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.source-sha"}}')"
[[ "$actual_sha" == "$source_sha" ]] || { echo "error: test-feed image provenance mismatch" >&2; exit 1; }
image_id="$(docker image inspect "$image" --format '{{.Id}}')"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "error: test-feed image ID is malformed" >&2; exit 1; }
wrapper_sha="$(shasum -a 256 "$0" | awk '{print $1}')"

docker_args=(
  run --rm -i
  --read-only
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m
  --cap-drop ALL
  --security-opt no-new-privileges
  --pids-limit 128
  --memory 1536m
  --cpus 2
  --user "$(id -u):$(id -g)"
  --mount "type=bind,src=$run_dir,dst=/evidence"
)
if [[ -t 0 && -t 1 ]]; then docker_args+=(-t); fi
for name in "${required[@]}"; do docker_args+=(--env "$name"); done
docker_args+=(
  --env "SCORECHECK_TEST_FEED_IMAGE_ID=$image_id"
  --env "SCORECHECK_TEST_FEED_SOURCE_SHA=$source_sha"
  --env "SCORECHECK_TEST_FEED_WRAPPER_SHA=$wrapper_sha"
)

set +e
docker "${docker_args[@]}" "$image" "${forwarded[@]}"
status=$?
set -e
if (( signal_status != 0 )); then status=$signal_status; fi

run_output="$run_dir/$output_name"
if [[ -f "$run_output" ]]; then
  ln "$run_output" "$output"
  rm -f "$run_output"
fi
exit "$status"
