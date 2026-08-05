#!/usr/bin/env bash
# Stop one exact owned Egress without clearing its replay contract. This is a
# qualification-only fault; the host supervisor must recover the same output
# generation from the preserved request and owner files.

set -euo pipefail
umask 077

# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

COURT="${1:?usage: fault-owned-egress.sh <court-number> <egress-id> <confirmation>}"
EGRESS_ID="${2:?usage: fault-owned-egress.sh <court-number> <egress-id> <confirmation>}"
CONFIRMATION="${3:?usage: fault-owned-egress.sh <court-number> <egress-id> <confirmation>}"
[[ "$COURT" =~ ^[1-8]$ ]] || { echo "error: court-number must be 1-8." >&2; exit 1; }
[[ "$EGRESS_ID" =~ ^EG_[A-Za-z0-9]+$ ]] || { echo "error: Egress id is invalid." >&2; exit 1; }
EXPECTED_CONFIRMATION="FAULT-OWNED-EGRESS:CAMERA-${COURT}:${EGRESS_ID}"
[[ "$CONFIRMATION" == "$EXPECTED_CONFIRMATION" ]] || {
  echo "error: exact confirmation is required: $EXPECTED_CONFIRMATION" >&2
  exit 1
}

for command in flock jq openssl systemctl; do
  command -v "$command" >/dev/null 2>&1 || { echo "error: $command is required." >&2; exit 1; }
done
load_env
require_livekit_env
find_lk
systemctl is-active --quiet scorecheck-egress-supervisor.service \
  || { echo "error: the Egress supervisor is not active; fault rejected." >&2; exit 1; }

REQ_DIR="$COMPOSITOR_DIR/requests"
OWNER_FILE="$REQ_DIR/court-${COURT}.owner.json"
REQUEST_FILE="$REQ_DIR/court-${COURT}.json"
ID_FILE="$REQ_DIR/court-${COURT}.egress-id"
STOP_INTENT="$REQ_DIR/court-${COURT}.stop-intent"
SUPERVISOR_STATE="${SCORECHECK_EGRESS_SUPERVISOR_EXPORT_DIR:-/var/lib/scorecheck-monitoring/egress-supervisor}/state.json"
for file in "$OWNER_FILE" "$REQUEST_FILE" "$ID_FILE"; do
  [[ -f "$file" && ! -L "$file" ]] || { echo "error: owned Egress contract is incomplete." >&2; exit 1; }
done
[[ -f "$SUPERVISOR_STATE" && ! -L "$SUPERVISOR_STATE" ]] \
  || { echo "error: the Egress supervisor has no verifiable healthy baseline." >&2; exit 1; }
[[ ! -e "$STOP_INTENT" ]] || { echo "error: a deliberate stop is already pending." >&2; exit 1; }

exec 9>"$REQ_DIR/start.lock"
flock -n 9 || { echo "error: another Egress lifecycle operation owns the lock." >&2; exit 1; }
jq -e --argjson court "$COURT" --arg id "$EGRESS_ID" '
  .schemaVersion == 1
  and .status == "HEALTHY"
  and .court == $court
  and .egressId == $id
  and (.generationKey | type) == "string"
  and (.generationKey | test("^[a-f0-9]{64}$"))
' "$SUPERVISOR_STATE" >/dev/null \
  || { echo "error: the Egress supervisor baseline does not match the exact owner." >&2; exit 1; }

REQUEST_SHA="$(jq -er --argjson court "$COURT" --arg id "$EGRESS_ID" '
  if .schemaVersion == 3
    and .court == $court
    and .egressId == $id
    and (.requestSha256 | type) == "string"
    and (.requestSha256 | test("^[a-f0-9]{64}$"))
  then .requestSha256
  else error("invalid owner")
  end
' "$OWNER_FILE")" || { echo "error: owned Egress identity is invalid." >&2; exit 1; }
[[ "$(<"$ID_FILE")" == "$EGRESS_ID" ]] || { echo "error: saved Egress id does not match." >&2; exit 1; }
ACTUAL_SHA="$(openssl dgst -sha256 -r "$REQUEST_FILE" | awk '{print $1}')"
[[ "$ACTUAL_SHA" == "$REQUEST_SHA" ]] || { echo "error: owned Egress request digest changed." >&2; exit 1; }

ACTIVE_FILE="$(mktemp "$REQ_DIR/.fault-active.XXXXXX")"
trap 'rm -f "$ACTIVE_FILE"' EXIT
"$LK" egress list --active --json >"$ACTIVE_FILE"
jq -e --arg id "$EGRESS_ID" '
  (. // []) as $active
  | ($active | type) == "array"
  and ($active | length) == 1
  and $active[0].egress_id == $id
' "$ACTIVE_FILE" >/dev/null || { echo "error: active Egress set does not match the exact owner." >&2; exit 1; }

STOP_STATUS=0
"$LK" egress stop --id "$EGRESS_ID" || STOP_STATUS=$?
for _ in $(seq 1 30); do
  "$LK" egress list --active --json >"$ACTIVE_FILE"
  if jq -e '(. // []) as $active | ($active | type) == "array" and ($active | length) == 0' "$ACTIVE_FILE" >/dev/null; then
    [[ -f "$OWNER_FILE" && -f "$REQUEST_FILE" && -f "$ID_FILE" && ! -e "$STOP_INTENT" ]] \
      || { echo "error: the recovery contract changed during fault injection." >&2; exit 1; }
    (( STOP_STATUS == 0 )) || echo "warning: the stop command failed but exact absence was reconciled." >&2
    echo "FAULTED Camera ${COURT} Egress ${EGRESS_ID}; recovery ownership preserved."
    exit 0
  fi
  jq -e --arg id "$EGRESS_ID" '(. // []) as $active | ($active | type) == "array" and ($active | length) == 1 and $active[0].egress_id == $id' "$ACTIVE_FILE" >/dev/null \
    || { echo "error: an unexpected Egress appeared during fault injection." >&2; exit 1; }
  sleep 1
done

echo "error: the exact owned Egress did not stop within 30 seconds." >&2
exit 1
