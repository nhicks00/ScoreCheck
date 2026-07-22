#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
load_env

[[ "${CAMERA_NORMALIZER_ENABLED:-}" == "true" ]] || { echo "error: this compositor is not assigned an HEVC normalizer" >&2; exit 64; }
[[ "${CAMERA_NUMBER:-}" =~ ^[1-8]$ ]] || { echo "error: CAMERA_NUMBER must be 1-8" >&2; exit 64; }
[[ "${MEDIAMTX_PRIVATE_HOST:-}" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]] || { echo "error: MEDIAMTX_PRIVATE_HOST must be private" >&2; exit 64; }

progress="/var/lib/scorecheck-monitoring/ffmpeg/court${CAMERA_NUMBER}_normalizer.progress"
rm -f "$progress"
docker compose --profile hevc-normalizer up -d --no-deps normalizer

for _ in $(seq 1 120); do
  running="$(docker inspect bvm-normalizer --format '{{.State.Running}}' 2>/dev/null || true)"
  restarts="$(docker inspect bvm-normalizer --format '{{.RestartCount}}' 2>/dev/null || true)"
  if [[ "$running" == "true" && "$restarts" == "0" && -s "$progress" ]]; then
    age=$(( $(date +%s) - $(stat -c %Y "$progress") ))
    if (( age <= 5 )) && grep -Eq '^frame=[1-9][0-9]*$' "$progress" && grep -Eq '^fps=[1-9][0-9]*(\.[0-9]+)?$' "$progress"; then
      echo "Camera ${CAMERA_NUMBER} HEVC normalizer is healthy."
      exit 0
    fi
  fi
  sleep 1
done

docker compose --profile hevc-normalizer ps normalizer >&2
docker compose --profile hevc-normalizer logs --tail=120 normalizer >&2 || true
echo "error: Camera ${CAMERA_NUMBER} HEVC normalizer did not become healthy" >&2
exit 1
