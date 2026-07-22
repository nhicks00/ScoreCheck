#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
load_env

docker compose --profile hevc-normalizer rm -sf normalizer >/dev/null
if [[ "${CAMERA_NUMBER:-}" =~ ^[1-8]$ ]]; then
  rm -f "/var/lib/scorecheck-monitoring/ffmpeg/court${CAMERA_NUMBER}_normalizer.progress"
fi
echo "Camera normalizer is stopped."
