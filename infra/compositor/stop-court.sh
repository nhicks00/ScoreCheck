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
"$LK" egress stop --id "$EGRESS_ID" || true

# LiveKit can acknowledge a stop before the job leaves the active list. Keep
# ownership and stop intent until the host is actually empty so a replacement
# cannot race the retiring publisher or appear ownerless to the supervisor.
ACTIVE_FILE="$(mktemp "$REQ_DIR/.stop-active.XXXXXX")"
trap 'rm -f "$ACTIVE_FILE"' EXIT
for (( attempt = 1; attempt <= 30; attempt += 1 )); do
  if ! "$LK" egress list --active --json >"$ACTIVE_FILE" 2>/dev/null; then
    echo "error: could not verify Egress drainage; stop intent retained." >&2
    exit 1
  fi
  if ! jq -e '
    . == null
    or (type == "array" and all(.[]; (.egress_id | type) == "string"))
  ' "$ACTIVE_FILE" >/dev/null; then
    echo "error: active Egress response was malformed; stop intent retained." >&2
    exit 1
  fi
  ACTIVE_IDS="$(jq -r '(. // []) | map(.egress_id) | join(" ")' "$ACTIVE_FILE")"
  if [[ -z "$ACTIVE_IDS" ]]; then
    break
  fi
  if [[ "$ACTIVE_IDS" != "$EGRESS_ID" ]]; then
    echo "error: active Egress ownership changed while stopping; stop intent retained." >&2
    exit 1
  fi
  if (( attempt == 30 )); then
    echo "error: owned Egress did not drain within 30 seconds; stop intent retained." >&2
    exit 1
  fi
  sleep 1
done

rm -f "$ID_FILE" "$OWNER_FILE" "$REQUEST_FILE" "$STOP_INTENT"
echo "court ${COURT}: stopped (ownership files cleared)"
