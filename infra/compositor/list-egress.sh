#!/usr/bin/env bash
# list-egress.sh — list egresses known to the compositor stack.
#
# Usage:
#   ./list-egress.sh              # active egresses only (default)
#   ./list-egress.sh --json       # any args replace the default and are passed
#   ./list-egress.sh --id EG_xxx  # straight through to `lk egress list`
#
# Useful flags (see `lk egress list --help`): --active, --id, --limit, --json.

set -euo pipefail

# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

load_env
require_livekit_env
find_lk

if [[ $# -eq 0 ]]; then
  exec "$LK" egress list --active
fi
exec "$LK" egress list "$@"
