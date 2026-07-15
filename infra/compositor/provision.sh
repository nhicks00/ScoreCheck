#!/usr/bin/env bash
# provision.sh — create a burst compositor droplet on DigitalOcean (REST API).
#
# Usage:
#   DIGITALOCEAN_TOKEN=dop_v1_... ./provision.sh --name NAME [options]
#
# Options:
#   --size SLUG      droplet size slug (default: c-4 — current safe baseline is
#                    one 720p30 web egress)
#   --image IMAGE    image slug or numeric snapshot id
#                    (default: ubuntu-24-04-x64; pass the bvm-compositor-base
#                    snapshot id once one exists)
#   --region REGION  DO region (default: sfo2 — same region as bvm-preview-01,
#                    keeping the WHEP hop droplet-local)
#   --ssh-key KEY    ssh key fingerprint or numeric id already registered in the
#                    DO account (required for real creates)
#   --ssh-private-key PATH  local private key used for post-create SSH
#                           (required with monitoring registration)
#   --event-manifest PATH  exact generated event manifest (required; lifecycle
#                          tags are attached in the original create request)
#   --name NAME      exact missing worker name from compositor-pool.json (required)
#   --courts COURT   assigned court; must match the worker's one-court pool slot
#   --register-monitoring  deploy/register the read-only agent after cloud-init
#   --observability-private-ip IP  private monitor IP (required with registration)
#   --dry-run        print the create-request JSON and exit — no API calls,
#                    no token required
#   -h, --help       this help
#
# Behavior:
#   - every real create runs the exact-pool account gate itself; a quota block,
#     conflicting name/shape, or compositor outside the approved pool aborts
#     before the DigitalOcean create request
#   - tags the droplet `bvm-compositor`; event-specific lifecycle tags are added
#     in the original create request from the exact generated event manifest
#   - boots with ./cloud-init.yaml as user_data (docker + compositor.service)
#   - polls the API until status=active, then prints the public IPv4 and the
#     rsync/start next-steps
#
# Deliberately NOT run automatically anywhere — Phase 2 is a manual, gated
# experiment (docs/PRODUCTION_PLATFORM_PLAN.md capacity topology).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="${SCORECHECK_DO_API_BASE:-https://api.digitalocean.com/v2}"
TAG="bvm-compositor"
LOCK_TAG="scorecheck-lock:compositor-pool"
POOL_SPEC="$SCRIPT_DIR/../event-stack/compositor-pool.json"
CAPACITY_PREFLIGHT="$SCRIPT_DIR/../event-stack/preflight-capacity.mjs"
EVENT_MANIFEST_TOOL="$SCRIPT_DIR/../event-stack/event-manifest.mjs"
EVENT_LIFECYCLE="$SCRIPT_DIR/../event-stack/lifecycle.sh"

SIZE="c-4"
IMAGE="ubuntu-24-04-x64"
REGION="sfo2"
NAME=""
SSH_KEY=""
SSH_PRIVATE_KEY=""
DRY_RUN=0
COURTS=""
REGISTER_MONITORING=0
OBSERVABILITY_PRIVATE_IP=""
EVENT_MANIFEST=""

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --size)    SIZE="$2"; shift 2 ;;
    --image)   IMAGE="$2"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --ssh-private-key) SSH_PRIVATE_KEY="$2"; shift 2 ;;
    --event-manifest) EVENT_MANIFEST="$2"; shift 2 ;;
    --name)    NAME="$2"; shift 2 ;;
    --courts)  COURTS="$2"; shift 2 ;;
    --register-monitoring) REGISTER_MONITORING=1; shift ;;
    --observability-private-ip) OBSERVABILITY_PRIVATE_IP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option '$1' (see --help)" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq / apt install jq)" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "error: node is required" >&2; exit 1; }
[[ -n "$NAME" ]] || { echo "error: --name is required" >&2; exit 1; }
[[ -f "$POOL_SPEC" ]] || { echo "error: compositor pool spec not found: $POOL_SPEC" >&2; exit 1; }
[[ -n "$EVENT_MANIFEST" && -f "$EVENT_MANIFEST" ]] || { echo "error: --event-manifest must name the generated event manifest" >&2; exit 1; }
EVENT_MANIFEST_SUMMARY="$(node "$EVENT_MANIFEST_TOOL" validate --manifest "$EVENT_MANIFEST" --pool-spec "$POOL_SPEC")"
EVENT_SLUG="$(jq -er '.event | select(type == "string" and length > 0)' <<<"$EVENT_MANIFEST_SUMMARY")"
DESTROY_AFTER="$(jq -er '.destroyAfter | select(type == "string" and length > 0)' <<<"$EVENT_MANIFEST_SUMMARY")"
EVENT_TAG="scorecheck-event:$EVENT_SLUG"
TEMPORARY_TAG="scorecheck-temporary"
DESTROY_TAG="scorecheck-destroy-after:$DESTROY_AFTER"
SLOT_COUNT="$(jq -r --arg name "$NAME" '[.workers[] | select(.name == $name)] | length' "$POOL_SPEC")"
[[ "$SLOT_COUNT" == "1" ]] || { echo "error: --name must identify exactly one worker in compositor-pool.json" >&2; exit 1; }
EXPECTED_COURT="$(jq -r --arg name "$NAME" '.workers[] | select(.name == $name) | .court // empty' "$POOL_SPEC")"
EXPECTED_SIZE="$(jq -r '.size' "$POOL_SPEC")"
EXPECTED_REGION="$(jq -r '.region' "$POOL_SPEC")"
EXPECTED_IMAGE="$(jq -r '.image' "$POOL_SPEC")"
[[ "$SIZE" == "$EXPECTED_SIZE" ]] || { echo "error: --size must match pool size $EXPECTED_SIZE" >&2; exit 1; }
[[ "$REGION" == "$EXPECTED_REGION" ]] || { echo "error: --region must match pool region $EXPECTED_REGION" >&2; exit 1; }
[[ "$IMAGE" == "$EXPECTED_IMAGE" ]] || { echo "error: --image must match pool image $EXPECTED_IMAGE" >&2; exit 1; }

if [[ "$REGISTER_MONITORING" -eq 1 ]]; then
  [[ -n "$SSH_KEY" ]] || { echo "error: --ssh-key is required with --register-monitoring" >&2; exit 1; }
  [[ -n "$SSH_PRIVATE_KEY" ]] || { echo "error: --ssh-private-key is required with --register-monitoring" >&2; exit 1; }
  [[ -n "$EXPECTED_COURT" ]] || { echo "error: the warm spare cannot be court-registered until it is assigned" >&2; exit 1; }
  [[ "$COURTS" == "$EXPECTED_COURT" ]] || { echo "error: --courts must be exactly $EXPECTED_COURT for $NAME" >&2; exit 1; }
  [[ -n "$OBSERVABILITY_PRIVATE_IP" ]] || { echo "error: --observability-private-ip is required with --register-monitoring" >&2; exit 1; }
fi

[[ -f "$SCRIPT_DIR/cloud-init.yaml" ]] || { echo "error: cloud-init.yaml not found next to this script" >&2; exit 1; }

if [[ -z "$SSH_KEY" && "$DRY_RUN" -eq 0 ]]; then
  echo "error: --ssh-key is required for a real compositor create" >&2
  exit 1
fi

# Build the create request. Numeric --image / --ssh-key values are sent as
# numbers (snapshot ids / key ids); anything else as strings (slugs / fingerprints).
REQUEST="$(jq -n \
  --arg name "$NAME" \
  --arg region "$REGION" \
  --arg size "$SIZE" \
  --arg image "$IMAGE" \
  --arg sshkey "$SSH_KEY" \
  --arg tag "$TAG" \
  --arg eventTag "$EVENT_TAG" \
  --arg temporaryTag "$TEMPORARY_TAG" \
  --arg destroyTag "$DESTROY_TAG" \
  --rawfile userdata "$SCRIPT_DIR/cloud-init.yaml" \
  '{
     name: $name,
     region: $region,
     size: $size,
     image: (if ($image | test("^[0-9]+$")) then ($image | tonumber) else $image end),
     tags: [$tag, $eventTag, $temporaryTag, $destroyTag],
     user_data: $userdata,
     monitoring: true,
     backups: false,
     ipv6: false
   }
   + (if $sshkey == "" then {}
      else { ssh_keys: [ (if ($sshkey | test("^[0-9]+$")) then ($sshkey | tonumber) else $sshkey end) ] }
      end)')"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run: would POST $API/droplets with:" >&2
  echo "$REQUEST" | jq .
  exit 0
fi

: "${DIGITALOCEAN_TOKEN:?set DIGITALOCEAN_TOKEN (or use --dry-run)}"
command -v curl >/dev/null 2>&1 || { echo "error: curl is required for DigitalOcean provisioning" >&2; exit 1; }
AUTH=(-H "Authorization: Bearer $DIGITALOCEAN_TOKEN" -H "Content-Type: application/json")

CAPACITY_OUTPUT="$(mktemp)"
LOCKED_CAPACITY_OUTPUT="$(mktemp)"
POST_CAPACITY_OUTPUT="$(mktemp)"
LOCK_RESPONSE="$(mktemp)"
CREATE_RESPONSE="$(mktemp)"
LOCK_ACQUIRED=0
RETAIN_LOCK=0

cleanup() {
  local rc="$?" lock_status encoded_lock
  trap - EXIT
  if [[ "$LOCK_ACQUIRED" -eq 1 && "$RETAIN_LOCK" -eq 1 ]]; then
    echo "error: provisioning lock $LOCK_TAG was retained because create/post-create verification is incomplete; inspect DigitalOcean inventory before removing it" >&2
    [[ "$rc" -ne 0 ]] || rc=1
  elif [[ "$LOCK_ACQUIRED" -eq 1 ]]; then
    encoded_lock="$(jq -rn --arg value "$LOCK_TAG" '$value | @uri')"
    lock_status="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$API/tags/$encoded_lock" "${AUTH[@]}" || true)"
    if [[ "$lock_status" != "204" ]]; then
      echo "error: provisioning lock $LOCK_TAG could not be released (HTTP $lock_status); leave provisioning stopped until it is inspected" >&2
      [[ "$rc" -ne 0 ]] || rc=1
    fi
  fi
  rm -f "$CAPACITY_OUTPUT" "$LOCKED_CAPACITY_OUTPUT" "$POST_CAPACITY_OUTPUT" "$LOCK_RESPONSE" "$CREATE_RESPONSE"
  exit "$rc"
}
trap cleanup EXIT

run_capacity_preflight() {
  local output="$1"
  node "$CAPACITY_PREFLIGHT" \
    --desired-compositors 8 \
    --warm-spares 1 \
    --size "$SIZE" \
    --region "$REGION" \
    --fleet-spec "$POOL_SPEC" >"$output"
}

if ! run_capacity_preflight "$CAPACITY_OUTPUT"; then
  jq '{status,account,compositors:{matchingActive,target,additionsRequired,totalDropletsAfterProvisioning,exactPlan},blockers}' "$CAPACITY_OUTPUT" >&2 || true
  echo "error: complete compositor pool is not safe to provision" >&2
  exit 1
fi
if ! jq -e --arg name "$NAME" '.compositors.exactPlan.missingSlots | any(.name == $name)' "$CAPACITY_OUTPUT" >/dev/null; then
  echo "error: $NAME is not an exact missing slot in the approved compositor pool" >&2
  exit 1
fi
MISSING_BEFORE="$(jq -r '.compositors.additionsRequired' "$CAPACITY_OUTPUT")"
echo "capacity preflight PASS: $MISSING_BEFORE approved compositor slot(s) missing before create"

"$EVENT_LIFECYCLE" prepare-tags --manifest "$EVENT_MANIFEST" >/dev/null

LOCK_STATUS="$(curl -sS -o "$LOCK_RESPONSE" -w '%{http_code}' -X POST "$API/tags" \
  "${AUTH[@]}" \
  -d "$(jq -cn --arg name "$LOCK_TAG" '{name:$name}')")"
if [[ "$LOCK_STATUS" != "201" ]]; then
  if [[ "$LOCK_STATUS" == "422" ]]; then
    ENCODED_LOCK="$(jq -rn --arg value "$LOCK_TAG" '$value | @uri')"
    EXISTING_LOCK_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' "$API/tags/$ENCODED_LOCK" "${AUTH[@]}" || true)"
    if [[ "$EXISTING_LOCK_STATUS" == "200" ]]; then
      echo "error: provisioning lock $LOCK_TAG already exists; another run may be active or a prior run needs inspection" >&2
      exit 1
    fi
  fi
  echo "error: could not acquire provisioning lock $LOCK_TAG (HTTP $LOCK_STATUS)" >&2
  exit 1
fi
LOCK_ACQUIRED=1

if ! run_capacity_preflight "$LOCKED_CAPACITY_OUTPUT"; then
  jq '{status,account,compositors:{matchingActive,target,additionsRequired,totalDropletsAfterProvisioning,exactPlan},blockers}' "$LOCKED_CAPACITY_OUTPUT" >&2 || true
  echo "error: capacity changed after the provisioning lock was acquired" >&2
  exit 1
fi
if [[ "$(jq -cS '.compositors.exactPlan.missingSlots' "$LOCKED_CAPACITY_OUTPUT")" != "$(jq -cS '.compositors.exactPlan.missingSlots' "$CAPACITY_OUTPUT")" ]]; then
  echo "error: compositor inventory changed during lock acquisition; rerun the preflight" >&2
  exit 1
fi

echo "creating droplet: name=$NAME size=$SIZE region=$REGION image=$IMAGE tag=$TAG"
RETAIN_LOCK=1
CREATE_STATUS="$(curl -sS -o "$CREATE_RESPONSE" -w '%{http_code}' -X POST "$API/droplets" "${AUTH[@]}" -d "$REQUEST")"
RESP="$(cat "$CREATE_RESPONSE")"
if [[ "$CREATE_STATUS" != "202" ]]; then
  case "$CREATE_STATUS" in
    400|401|403|404|409|422) RETAIN_LOCK=0 ;;
  esac
  echo "error: create request returned HTTP $CREATE_STATUS" >&2
  jq . "$CREATE_RESPONSE" >&2 2>/dev/null || true
  exit 1
fi
DROPLET_ID="$(jq -r '.droplet.id // empty' <<<"$RESP")"
if [[ -z "$DROPLET_ID" ]]; then
  echo "error: create was accepted without a concrete Droplet id; outcome requires inspection" >&2
  echo "$RESP" | jq . >&2
  exit 1
fi

echo "droplet id $DROPLET_ID created; polling until active (typically ~60s)..."
STATUS=""
STATUS_RESP=""
for i in $(seq 1 30); do
  sleep 10
  STATUS_RESP="$(curl -sS "$API/droplets/$DROPLET_ID" "${AUTH[@]}")"
  STATUS="$(jq -r '.droplet.status // "unknown"' <<<"$STATUS_RESP")"
  if [[ "$STATUS" == "active" ]]; then
    break
  fi
  echo "  ...status=$STATUS ($((i * 10))s)"
done

if [[ "$STATUS" != "active" ]]; then
  echo "error: droplet $DROPLET_ID not active after 300s (status=$STATUS)." >&2
  echo "  inspect: curl -sS $API/droplets/$DROPLET_ID -H 'Authorization: Bearer \$DIGITALOCEAN_TOKEN'" >&2
  echo "  do not run a tag-wide teardown; inspect this exact droplet id before any cleanup" >&2
  exit 1
fi

IP="$(jq -r '[.droplet.networks.v4[] | select(.type == "public")][0].ip_address // empty' <<<"$STATUS_RESP")"
PRIVATE_IP="$(jq -r '[.droplet.networks.v4[] | select(.type == "private")][0].ip_address // empty' <<<"$STATUS_RESP")"
if ! jq -e \
  --arg base "$TAG" \
  --arg event "$EVENT_TAG" \
  --arg temporary "$TEMPORARY_TAG" \
  --arg destroy "$DESTROY_TAG" \
  '(.droplet.tags | index($base)) and (.droplet.tags | index($event)) and (.droplet.tags | index($temporary)) and (.droplet.tags | index($destroy))' \
  <<<"$STATUS_RESP" >/dev/null; then
  echo "error: droplet $DROPLET_ID is active but its create-time lifecycle tags are incomplete; provisioning remains locked" >&2
  exit 1
fi
echo
echo "droplet active: $NAME  id=$DROPLET_ID  public=${IP:-<none>} private=${PRIVATE_IP:-<none>}"

if [[ "$REGISTER_MONITORING" -eq 1 ]]; then
  [[ -n "$IP" && -n "$PRIVATE_IP" ]] || { echo "error: droplet addresses unavailable for monitoring registration" >&2; exit 1; }
  ssh -i "$SSH_PRIVATE_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "root@$IP" cloud-init status --wait
  MONITOR_AGENT_SSH_KEY="$SSH_PRIVATE_KEY" "$SCRIPT_DIR/register-monitoring.sh" \
    --name "$NAME" \
    --ssh-host "root@$IP" \
    --private-ip "$PRIVATE_IP" \
    --courts "$COURTS" \
    --observability-private-ip "$OBSERVABILITY_PRIVATE_IP" \
    --refresh
fi

if ! node "$CAPACITY_PREFLIGHT" \
  --desired-compositors 8 \
  --warm-spares 1 \
  --size "$SIZE" \
  --region "$REGION" \
  --fleet-spec "$POOL_SPEC" >"$POST_CAPACITY_OUTPUT"; then
  jq '{status,account,compositors:{matchingActive,target,additionsRequired,exactPlan},blockers}' "$POST_CAPACITY_OUTPUT" >&2 || true
  echo "error: $NAME was created, but the exact-pool post-create verification failed; inspect before any further create" >&2
  exit 1
fi
MISSING_AFTER="$(jq -r '.compositors.additionsRequired' "$POST_CAPACITY_OUTPUT")"
if [[ "$MISSING_AFTER" -ne $((MISSING_BEFORE - 1)) ]] \
  || ! jq -e --arg name "$NAME" '.compositors.exactPlan.matchedNames | index($name) != null' "$POST_CAPACITY_OUTPUT" >/dev/null; then
  echo "error: $NAME was created, but exact-pool inventory did not advance by one slot" >&2
  exit 1
fi
RETAIN_LOCK=0
if [[ "$MISSING_AFTER" -eq 0 ]]; then
  echo "exact-pool verification PASS: compositor pool is COMPLETE"
else
  echo "worker verification PASS: compositor pool remains INCOMPLETE with $MISSING_AFTER approved slot(s) missing"
fi
cat <<NEXT

Next steps (cloud-init keeps installing docker for ~2-4 min after 'active';
check with: ssh root@$IP cloud-init status --wait):

  1. push the compositor bundle:
       rsync -av --exclude requests/ --exclude .env "$SCRIPT_DIR/" root@$IP:/opt/compositor/
  2. create /opt/compositor/.env on the droplet (see .env.example)
  3. ssh root@$IP systemctl start compositor
  4. verify:  ssh root@$IP docker compose -f /opt/compositor/docker-compose.yml ps
  5. start the assigned court only after event admission passes:
       ${EXPECTED_COURT:+cd /opt/compositor && ./start-court.sh $EXPECTED_COURT}${EXPECTED_COURT:-warm spare: no court is assigned}

The exact generated event manifest was bound before create and all lifecycle
tags were verified on the active Droplet. Never use a tag-wide teardown.
NEXT
