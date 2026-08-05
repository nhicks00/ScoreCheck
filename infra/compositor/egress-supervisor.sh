#!/usr/bin/env bash
# Keep the single owned web Egress alive without ever guessing output identity.

set -euo pipefail
umask 077

# shellcheck source=lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE="${1:-watch}"
if [[ "$MODE" != "once" && "$MODE" != "watch" ]]; then
  echo "error: usage: egress-supervisor.sh [once|watch]" >&2
  exit 1
fi

INTERVAL_SECONDS="${SCORECHECK_EGRESS_SUPERVISOR_INTERVAL_SECONDS:-5}"
MISSING_POLLS_REQUIRED=3
MAX_RECOVERY_ATTEMPTS=2
STATE_DIR="${SCORECHECK_EGRESS_SUPERVISOR_STATE_DIR:-/var/lib/scorecheck-egress-supervisor}"
STATE_FILE="$STATE_DIR/state.json"
EXPORT_DIR="${SCORECHECK_EGRESS_SUPERVISOR_EXPORT_DIR:-/var/lib/scorecheck-monitoring/egress-supervisor}"
EXPORT_FILE="$EXPORT_DIR/state.json"
REQ_DIR="$COMPOSITOR_DIR/requests"

for value in "$INTERVAL_SECONDS"; do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || {
    echo "error: supervisor interval must be a positive integer." >&2
    exit 1
  }
done
for command in curl docker flock jq openssl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "error: $command is required by the Egress supervisor." >&2
    exit 1
  }
done

mkdir -p "$REQ_DIR" "$STATE_DIR" "$EXPORT_DIR"
chmod 700 "$REQ_DIR" "$STATE_DIR"
# The exported status directory is mounted read-only by the unprivileged
# monitoring agent and contains no credentials or request payloads.
chmod 755 "$EXPORT_DIR"
load_env
require_livekit_env
find_lk

write_state() {
  local generation_key="$1" missing_count="$2" recovery_attempts="$3" status="$4" detail="$5"
  local court="${6:-null}" egress_id="${7:-}" output="$STATE_FILE.tmp.$$" exported="$EXPORT_FILE.tmp.$$"
  jq -n \
    --arg generationKey "$generation_key" \
    --argjson missingCount "$missing_count" \
    --argjson recoveryAttempts "$recovery_attempts" \
    --arg status "$status" \
    --arg detail "$detail" \
    --argjson court "$court" \
    --arg egressId "$egress_id" \
    --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schemaVersion: 1, generationKey: ($generationKey | select(length > 0) // null), missingCount: $missingCount, recoveryAttempts: $recoveryAttempts, status: $status, detail: $detail, court: $court, egressId: ($egressId | select(length > 0) // null), observedAt: $observedAt}' \
    >"$output"
  chmod 600 "$output"
  mv "$output" "$STATE_FILE"
  # The export contains operational status only and is mounted read-only by the
  # unprivileged monitoring agent.
  install -m 0644 "$STATE_FILE" "$exported"
  mv "$exported" "$EXPORT_FILE"
  printf '%s: %s\n' "$status" "$detail"
}

read_counts() {
  local generation_key="$1"
  if [[ ! -e "$STATE_FILE" ]]; then
    printf '0 0\n'
    return
  fi
  if [[ ! -f "$STATE_FILE" || -L "$STATE_FILE" ]]; then
    echo "error: supervisor state is not a regular file." >&2
    return 1
  fi
  jq -er --arg generationKey "$generation_key" '
    if .schemaVersion != 1
      or (.generationKey != null and (.generationKey | type) != "string")
      or (.missingCount | type) != "number" or (.missingCount | floor) != .missingCount or .missingCount < 0
      or (.recoveryAttempts | type) != "number" or (.recoveryAttempts | floor) != .recoveryAttempts or .recoveryAttempts < 0
    then error("invalid supervisor state")
    elif .generationKey == $generationKey then "\(.missingCount) \(.recoveryAttempts)"
    else "0 0"
    end
  ' "$STATE_FILE"
}

ACTIVE_IDS=()
load_active_ids() {
  local output="$STATE_DIR/active.$$.json" error="$STATE_DIR/active.$$.error"
  ACTIVE_IDS=()
  if ! "$LK" egress list --active --json >"$output" 2>"$error"; then
    chmod 600 "$error"
    echo "error: LiveKit active Egress query failed; protected diagnostics are in $error." >&2
    return 1
  fi
  if ! jq -r '
    if . == null then empty
    elif type == "array" and all(.[]; .egress_id as $id | ($id | type) == "string" and ($id | test("^EG_[A-Za-z0-9]+$")))
      then .[].egress_id
    else error("unexpected Egress list JSON")
    end
  ' "$output" >"$output.ids"; then
    echo "error: LiveKit active Egress response was malformed." >&2
    return 1
  fi
  while IFS= read -r id; do
    [[ -n "$id" ]] && ACTIVE_IDS+=("$id")
  done <"$output.ids"
  rm -f "$output" "$output.ids" "$error"
}

wait_for_active_id() {
  local expected_id="$1"
  for _ in $(seq 1 30); do
    if load_active_ids \
      && (( ${#ACTIVE_IDS[@]} == 1 )) \
      && [[ "${ACTIVE_IDS[0]}" == "$expected_id" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

adopt_single_started_id() {
  local start_log="$1" parsed_id=""
  parsed_id="$(grep -oE 'EG_[A-Za-z0-9]+' "$start_log" | sort -u | head -n2 || true)"
  if [[ "$(printf '%s\n' "$parsed_id" | sed '/^$/d' | wc -l | tr -d ' ')" == "1" ]]; then
    printf '%s\n' "$parsed_id"
    return
  fi
  load_active_ids || return 1
  if (( ${#ACTIVE_IDS[@]} == 1 )); then
    printf '%s\n' "${ACTIVE_IDS[0]}"
    return
  fi
  return 1
}

reconcile_once() {
  local owners=() stop_intents=() owner_file request_file id_file court owner_id request_sha generation_key
  local renderer_git_sha renderer_deployment_id renderer_release_origin renderer_binding_file
  local counts missing_count recovery_attempts old_container_id start_log start_status new_id owner_tmp id_tmp

  exec 9>"$REQ_DIR/start.lock"
  if ! flock -n 9; then
    write_state "" 0 0 "BUSY" "Another Egress lifecycle operation owns the lock."
    return
  fi

  shopt -s nullglob
  owners=("$REQ_DIR"/court-*.owner.json)
  stop_intents=("$REQ_DIR"/court-*.stop-intent)
  shopt -u nullglob

  if (( ${#stop_intents[@]} > 0 )); then
    write_state "" 0 0 "STOP_INTENT" "A deliberate stop is pending; automatic recovery is suppressed."
    return
  fi
  if (( ${#owners[@]} == 0 )); then
    if ! load_active_ids; then
      write_state "" 0 0 "CONTROL_UNAVAILABLE" "The active Egress list could not be verified."
      return
    fi
    if (( ${#ACTIVE_IDS[@]} == 0 )); then
      write_state "" 0 0 "IDLE" "No owned or active Egress exists."
    else
      write_state "" 0 0 "OWNERLESS_ACTIVE" "An active Egress exists without an owner; no mutation was attempted." null "${ACTIVE_IDS[0]}"
    fi
    return
  fi
  if (( ${#owners[@]} != 1 )); then
    write_state "" 0 0 "AMBIGUOUS_OWNER" "More than one Egress owner exists; no mutation was attempted."
    return
  fi

  owner_file="${owners[0]}"
  if [[ ! -f "$owner_file" || -L "$owner_file" ]]; then
    write_state "" 0 0 "INVALID_OWNER" "The Egress owner is not a regular file."
    return
  fi
  if ! read -r court owner_id request_sha generation_key renderer_git_sha renderer_deployment_id renderer_release_origin < <(jq -er '
    if .schemaVersion == 3
      and (.court | type) == "number" and (.court | floor) == .court and .court >= 1 and .court <= 8
      and (.egressId | type) == "string" and (.egressId | test("^EG_[A-Za-z0-9]+$"))
      and (.requestSha256 | type) == "string" and (.requestSha256 | test("^[a-f0-9]{64}$"))
      and (.event | type) == "string" and (.event | test("^[A-Za-z0-9._-]{3,128}$"))
      and (.destinationId | type) == "string" and (.destinationId | test("^[A-Za-z0-9._-]{3,128}$"))
      and (.destinationRole == "primary" or .destinationRole == "backup")
      and (.outputGeneration | type) == "string" and (.outputGeneration | test("^[A-Za-z0-9._-]{3,128}$"))
      and (.outputProfile == "1080p30" or .outputProfile == "1080p60")
      and (.rendererGitSha | type) == "string" and (.rendererGitSha | test("^[a-f0-9]{40}$"))
      and (.rendererDeploymentId | type) == "string" and (.rendererDeploymentId | test("^dpl_[A-Za-z0-9]+$"))
      and .rendererRuntimeOrigin == "http://renderer:3000"
      and (.rendererReleaseOrigin | type) == "string" and (.rendererReleaseOrigin | test("^https://[a-z0-9-]+[.]vercel[.]app$"))
      and (.rendererBundleSha256 | type) == "string" and (.rendererBundleSha256 | test("^[a-f0-9]{64}$"))
    then [.court, .egressId, .requestSha256, ([.event, .destinationId, .destinationRole, .outputGeneration, .requestSha256] | join("|")), .rendererGitSha, .rendererDeploymentId, .rendererReleaseOrigin] | @tsv
    else error("invalid owner")
    end
  ' "$owner_file"); then
    write_state "" 0 0 "INVALID_OWNER" "The Egress owner contract is invalid."
    return
  fi
  generation_key="$(printf '%s' "$generation_key" | openssl dgst -sha256 -r | awk '{print $1}')"
  request_file="$REQ_DIR/court-${court}.json"
  id_file="$REQ_DIR/court-${court}.egress-id"
  if [[ ! -f "$request_file" || -L "$request_file" || ! -f "$id_file" || -L "$id_file" ]]; then
    write_state "$generation_key" 0 0 "INVALID_OWNER" "The owned request or Egress id file is missing." "$court" "$owner_id"
    return
  fi
  if [[ "$(<"$id_file")" != "$owner_id" || "$(openssl dgst -sha256 -r "$request_file" | awk '{print $1}')" != "$request_sha" ]]; then
    write_state "$generation_key" 0 0 "INVALID_OWNER" "The request digest or Egress id does not match its owner." "$court" "$owner_id"
    return
  fi
  if ! counts="$(read_counts "$generation_key")"; then
    echo "error: supervisor state is invalid; recovery is disabled." >&2
    return 1
  fi
  read -r missing_count recovery_attempts <<<"$counts"
  if ! load_active_ids; then
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "CONTROL_UNAVAILABLE" "The active Egress list could not be verified." "$court" "$owner_id"
    return
  fi
  if (( ${#ACTIVE_IDS[@]} == 1 )) && [[ "${ACTIVE_IDS[0]}" == "$owner_id" ]]; then
    write_state "$generation_key" 0 "$recovery_attempts" "HEALTHY" "The exact owned Egress is active." "$court" "$owner_id"
    return
  fi
  if (( ${#ACTIVE_IDS[@]} > 0 )); then
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "AMBIGUOUS_ACTIVE" "The active Egress set does not match the owner; no mutation was attempted." "$court" "$owner_id"
    return
  fi

  missing_count=$((missing_count + 1))
  if (( missing_count < MISSING_POLLS_REQUIRED )); then
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "MISSING_PENDING" "The owned Egress is absent; waiting for repeated confirmation." "$court" "$owner_id"
    return
  fi
  if (( recovery_attempts >= MAX_RECOVERY_ATTEMPTS )); then
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "RECOVERY_EXHAUSTED" "The bounded recovery budget is exhausted." "$court" "$owner_id"
    return
  fi

  renderer_binding_file="$STATE_DIR/renderer-binding.$$.json"
  if ! curl -fsS --max-time 5 http://127.0.0.1:3000/api/program/renderer-binding >"$renderer_binding_file" \
    || ! jq -e \
      --arg origin "$renderer_release_origin" \
      --arg gitSha "$renderer_git_sha" \
      --arg deploymentId "$renderer_deployment_id" '
        .schemaVersion == 1
        and .provider == "vercel"
        and .origin == $origin
        and .gitSha == $gitSha
        and .deploymentId == $deploymentId
        and .assetNamespace == $deploymentId
        and .contracts == {
          programSession: "program-session-v1",
          overlayState: "overlay-state-v1",
          commentary: "commentary-v1",
          browserHeartbeat: "browser-heartbeat-v6"
        }
      ' "$renderer_binding_file" >/dev/null; then
    rm -f "$renderer_binding_file"
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "CONTROL_UNAVAILABLE" "The event-local renderer identity could not be verified; recovery was not attempted." "$court" "$owner_id"
    return
  fi
  rm -f "$renderer_binding_file"

  recovery_attempts=$((recovery_attempts + 1))
  write_state "$generation_key" "$missing_count" "$recovery_attempts" "RECOVERING" "Recycling the Egress worker before exact request replay." "$court" "$owner_id"
  old_container_id="$(docker inspect bvm-egress --format '{{.Id}}' 2>/dev/null || true)"
  if ! docker compose -f "$COMPOSITOR_DIR/docker-compose.yml" --project-directory "$COMPOSITOR_DIR" up -d --force-recreate egress >/dev/null; then
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "RECOVERY_FAILED" "The Egress worker could not be recreated." "$court" "$owner_id"
    return
  fi
  if ! wait_for_recycled_egress_worker "$old_container_id"; then
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "RECOVERY_FAILED" "The recycled worker did not become idle, admissible, and PulseAudio-capable." "$court" "$owner_id"
    return
  fi
  if ! load_active_ids || (( ${#ACTIVE_IDS[@]} != 0 )); then
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "RECOVERY_FAILED" "The control plane was not empty before request replay." "$court" "$owner_id"
    return
  fi

  start_log="$STATE_DIR/recovery-start.$$.log"
  set +e
  "$LK" egress start --type web "$request_file" >"$start_log" 2>&1
  start_status=$?
  set -e
  chmod 600 "$start_log"
  if ! new_id="$(adopt_single_started_id "$start_log")"; then
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "RECOVERY_FAILED" "Exact request replay did not produce one adoptable Egress id; protected diagnostics were retained." "$court" "$owner_id"
    return
  fi
  if ! wait_for_active_id "$new_id"; then
    write_state "$generation_key" "$missing_count" "$recovery_attempts" "RECOVERY_FAILED" "Request replay did not converge to one exact active Egress; protected diagnostics were retained." "$court" "$owner_id"
    return
  fi
  if (( start_status != 0 )); then
    printf 'warning: start command returned %s but exactly one active id was adopted after reconciliation.\n' "$start_status" >&2
  fi

  owner_tmp="$owner_file.tmp.$$"
  id_tmp="$id_file.tmp.$$"
  jq --arg egressId "$new_id" --arg startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.egressId = $egressId | .startedAt = $startedAt' "$owner_file" >"$owner_tmp"
  printf '%s\n' "$new_id" >"$id_tmp"
  chmod 600 "$owner_tmp" "$id_tmp"
  mv "$owner_tmp" "$owner_file"
  mv "$id_tmp" "$id_file"
  rm -f "$start_log"
  write_state "$generation_key" 0 "$recovery_attempts" "RECOVERED" "The worker was recycled and one exact owned Egress was restarted." "$court" "$new_id"
}

if [[ "$MODE" == "once" ]]; then
  reconcile_once
  exit
fi

while true; do
  if ! reconcile_once; then
    echo "error: Egress reconciliation failed closed; retrying without mutation." >&2
  fi
  sleep "$INTERVAL_SECONDS"
done
