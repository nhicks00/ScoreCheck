#!/usr/bin/env bash
# provision.sh — create a burst compositor droplet on DigitalOcean (REST API).
#
# Usage:
#   DIGITALOCEAN_TOKEN=dop_v1_... ./provision.sh [options]
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
#                    DO account (recommended; without it DO emails a root password)
#   --name NAME      droplet name (default: bvm-compositor-01)
#   --courts LIST    assigned courts, e.g. 1,2 (required with monitoring registration)
#   --register-monitoring  deploy/register the read-only agent after cloud-init
#   --observability-private-ip IP  private monitor IP (required with registration)
#   --dry-run        print the create-request JSON and exit — no API calls,
#                    no token required
#   -h, --help       this help
#
# Behavior:
#   - for a multi-worker expansion, first run the read-only account gate:
#       node ../event-stack/preflight-capacity.mjs \
#         --desired-compositors 8 --warm-spares 1 --size c-4 --region sfo2
#     Do not start a partial pool when that command reports BLOCKED.
#   - tags the droplet `bvm-compositor` (teardown.sh destroys by this tag only,
#     so it can never touch bvm-preview-01)
#   - boots with ./cloud-init.yaml as user_data (docker + compositor.service)
#   - polls the API until status=active, then prints the public IPv4 and the
#     rsync/start next-steps
#
# Deliberately NOT run automatically anywhere — Phase 2 is a manual, gated
# experiment (docs/PRODUCTION_PLATFORM_PLAN.md capacity topology).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="https://api.digitalocean.com/v2"
TAG="bvm-compositor"

SIZE="c-4"
IMAGE="ubuntu-24-04-x64"
REGION="sfo2"
NAME="bvm-compositor-01"
SSH_KEY=""
DRY_RUN=0
COURTS=""
REGISTER_MONITORING=0
OBSERVABILITY_PRIVATE_IP=""

usage() { sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --size)    SIZE="$2"; shift 2 ;;
    --image)   IMAGE="$2"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --name)    NAME="$2"; shift 2 ;;
    --courts)  COURTS="$2"; shift 2 ;;
    --register-monitoring) REGISTER_MONITORING=1; shift ;;
    --observability-private-ip) OBSERVABILITY_PRIVATE_IP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option '$1' (see --help)" >&2; exit 1 ;;
  esac
done

if [[ "$REGISTER_MONITORING" -eq 1 ]]; then
  [[ -n "$SSH_KEY" ]] || { echo "error: --ssh-key is required with --register-monitoring" >&2; exit 1; }
  [[ "$COURTS" =~ ^[1-8](,[1-8])*$ ]] || { echo "error: --courts must be supplied with --register-monitoring" >&2; exit 1; }
  [[ -n "$OBSERVABILITY_PRIVATE_IP" ]] || { echo "error: --observability-private-ip is required with --register-monitoring" >&2; exit 1; }
fi

command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq / apt install jq)" >&2; exit 1; }
[[ -f "$SCRIPT_DIR/cloud-init.yaml" ]] || { echo "error: cloud-init.yaml not found next to this script" >&2; exit 1; }

if [[ -z "$SSH_KEY" && "$DRY_RUN" -eq 0 ]]; then
  echo "warning: no --ssh-key given — DigitalOcean will email a root password instead." >&2
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
  --rawfile userdata "$SCRIPT_DIR/cloud-init.yaml" \
  '{
     name: $name,
     region: $region,
     size: $size,
     image: (if ($image | test("^[0-9]+$")) then ($image | tonumber) else $image end),
     tags: [$tag],
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
AUTH=(-H "Authorization: Bearer $DIGITALOCEAN_TOKEN" -H "Content-Type: application/json")

echo "creating droplet: name=$NAME size=$SIZE region=$REGION image=$IMAGE tag=$TAG"
RESP="$(curl -sS -X POST "$API/droplets" "${AUTH[@]}" -d "$REQUEST")"
DROPLET_ID="$(jq -r '.droplet.id // empty' <<<"$RESP")"
if [[ -z "$DROPLET_ID" ]]; then
  echo "error: create failed — API response:" >&2
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
  echo "  destroy: ./teardown.sh" >&2
  exit 1
fi

IP="$(jq -r '[.droplet.networks.v4[] | select(.type == "public")][0].ip_address // empty' <<<"$STATUS_RESP")"
PRIVATE_IP="$(jq -r '[.droplet.networks.v4[] | select(.type == "private")][0].ip_address // empty' <<<"$STATUS_RESP")"
echo
echo "droplet active: $NAME  id=$DROPLET_ID  public=${IP:-<none>} private=${PRIVATE_IP:-<none>}"

if [[ "$REGISTER_MONITORING" -eq 1 ]]; then
  [[ -n "$IP" && -n "$PRIVATE_IP" ]] || { echo "error: droplet addresses unavailable for monitoring registration" >&2; exit 1; }
  ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new "root@$IP" cloud-init status --wait
  "$SCRIPT_DIR/register-monitoring.sh" \
    --name "$NAME" \
    --ssh-host "root@$IP" \
    --private-ip "$PRIVATE_IP" \
    --courts "$COURTS" \
    --observability-private-ip "$OBSERVABILITY_PRIVATE_IP" \
    --refresh
fi
cat <<NEXT

Next steps (cloud-init keeps installing docker for ~2-4 min after 'active';
check with: ssh root@$IP cloud-init status --wait):

  1. push the compositor bundle:
       rsync -av --exclude requests/ --exclude .env "$SCRIPT_DIR/" root@$IP:/opt/compositor/
  2. create /opt/compositor/.env on the droplet (see .env.example)
  3. ssh root@$IP systemctl start compositor
  4. verify:  ssh root@$IP docker compose -f /opt/compositor/docker-compose.yml ps
  5. start a court (on the droplet): cd /opt/compositor && ./start-court.sh 1

Teardown when done: ./teardown.sh   (destroys ALL droplets tagged $TAG)
NEXT
