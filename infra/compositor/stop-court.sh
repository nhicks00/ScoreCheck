#!/usr/bin/env bash
# stop-court.sh — stop the web egress for court N (ends its YouTube push).
#
# Usage:
#   ./stop-court.sh <court-number>            # id from requests/court-<N>.egress-id
#   ./stop-court.sh <court-number> EG_xxxx    # explicit id (see ./list-egress.sh)
#
# The saved id and owner files are written by start-court.sh and removed here on success.

set -euo pipefail
umask 077

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

REQ_DIR="$COMPOSITOR_DIR/requests"
mkdir -p "$REQ_DIR"
command -v flock >/dev/null 2>&1 || { echo "error: flock is required for serialized Egress shutdown." >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "error: jq is required for owned Egress shutdown." >&2; exit 1; }
exec 9>"$REQ_DIR/start.lock"
flock 9

ID_FILE="$REQ_DIR/court-${COURT}.egress-id"
OWNER_FILE="$REQ_DIR/court-${COURT}.owner.json"
REQUEST_FILE="$REQ_DIR/court-${COURT}.json"
STOP_INTENT="$REQ_DIR/court-${COURT}.stop-intent"
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
if ! [[ "$EGRESS_ID" =~ ^EG_[A-Za-z0-9]+$ ]]; then
  echo "error: invalid Egress id '$EGRESS_ID'." >&2
  exit 1
fi
if [[ -f "$OWNER_FILE" ]]; then
  OWNED_ID="$(jq -er '.egressId | select(test("^EG_[A-Za-z0-9]+$"))' "$OWNER_FILE")"
  if [[ "$OWNED_ID" != "$EGRESS_ID" ]]; then
    echo "error: explicit Egress id does not match the saved owner; stop rejected." >&2
    exit 1
  fi
fi

echo "court ${COURT}: stopping egress ${EGRESS_ID}"
printf '%s\n' "$EGRESS_ID" >"${STOP_INTENT}.tmp"
chmod 600 "${STOP_INTENT}.tmp"
mv "${STOP_INTENT}.tmp" "$STOP_INTENT"
if ! "$LK" egress stop --id "$EGRESS_ID"; then
  ACTIVE_FILE="$(mktemp "$REQ_DIR/.stop-active.XXXXXX")"
  if ! "$LK" egress list --active --json >"$ACTIVE_FILE" 2>/dev/null \
    || ! jq -e --arg id "$EGRESS_ID" '(. // []) as $items | ($items | type) == "array" and ([$items[]? | select(.egress_id == $id)] | length == 0)' "$ACTIVE_FILE" >/dev/null; then
    echo "error: stop failed and the owned Egress may still be active; stop intent retained." >&2
    exit 1
  fi
fi

rm -f "$ID_FILE" "$OWNER_FILE" "$REQUEST_FILE" "$STOP_INTENT"
echo "court ${COURT}: stopped (ownership files cleared)"
