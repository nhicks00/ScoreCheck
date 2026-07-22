#!/usr/bin/env bash
# stop-court.sh — stop the web egress for court N (ends its YouTube push).
#
# Usage:
#   ./stop-court.sh <court-number>            # id from requests/court-<N>.egress-id
#   ./stop-court.sh <court-number> EG_xxxx    # explicit id (see ./list-egress.sh)
#
# The saved id and owner files are written by start-court.sh and removed here on success.

set -euo pipefail

# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

COURT="${1:?usage: stop-court.sh <court-number> [egress-id]}"
if ! [[ "$COURT" =~ ^[0-9]+$ ]]; then
  echo "error: court-number must be an integer, got '$COURT'" >&2
  exit 1
fi

load_env
require_livekit_env
find_lk

ID_FILE="$COMPOSITOR_DIR/requests/court-${COURT}.egress-id"
OWNER_FILE="$COMPOSITOR_DIR/requests/court-${COURT}.owner.json"
EGRESS_ID="${2:-}"
if [[ -z "$EGRESS_ID" ]]; then
  if [[ -f "$ID_FILE" ]]; then
    EGRESS_ID="$(<"$ID_FILE")"
  elif [[ -f "$OWNER_FILE" ]] && command -v jq >/dev/null 2>&1; then
    EGRESS_ID="$(jq -er '.egressId | select(test("^EG_[A-Za-z0-9]+$"))' "$OWNER_FILE")"
  else
    echo "error: no saved egress ownership for Camera ${COURT}." >&2
    echo "  find the id with ./list-egress.sh, then: ./stop-court.sh ${COURT} EG_..." >&2
    exit 1
  fi
fi

echo "court ${COURT}: stopping egress ${EGRESS_ID}"
"$LK" egress stop --id "$EGRESS_ID"

rm -f "$ID_FILE" "$OWNER_FILE"
echo "court ${COURT}: stopped (ownership files cleared)"
