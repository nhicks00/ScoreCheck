#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="https://api.digitalocean.com/v2"
TAG="bvm-observability"
SIZE="s-2vcpu-4gb"
IMAGE="ubuntu-24-04-x64"
REGION="sfo2"
NAME="bvm-observability-01"
SSH_KEY=""
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: DIGITALOCEAN_TOKEN=... ./provision.sh [options]

  --size SLUG      default s-2vcpu-4gb
  --image IMAGE    default ubuntu-24-04-x64
  --region REGION  default sfo2
  --ssh-key KEY    registered key id or fingerprint
  --name NAME      default bvm-observability-01
  --dry-run        print the request without creating a droplet
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --size) SIZE="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option '$1'" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }
[[ -f "$SCRIPT_DIR/cloud-init.yaml" ]] || { echo "error: cloud-init.yaml missing" >&2; exit 1; }

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
  } + (if $sshkey == "" then {} else {ssh_keys: [(if ($sshkey | test("^[0-9]+$")) then ($sshkey | tonumber) else $sshkey end)]} end)')"

if [[ "$DRY_RUN" -eq 1 ]]; then
  jq . <<<"$REQUEST"
  exit 0
fi

: "${DIGITALOCEAN_TOKEN:?DIGITALOCEAN_TOKEN is required}"
AUTH=(-H "Authorization: Bearer $DIGITALOCEAN_TOKEN" -H "Content-Type: application/json")
response="$(curl -fsS -X POST "$API/droplets" "${AUTH[@]}" -d "$REQUEST")"
droplet_id="$(jq -r '.droplet.id // empty' <<<"$response")"
[[ -n "$droplet_id" ]] || { echo "error: DigitalOcean did not return a droplet id" >&2; exit 1; }
echo "Created observability droplet $droplet_id; waiting for active state."

status_response=""
for attempt in $(seq 1 40); do
  sleep 10
  status_response="$(curl -fsS "$API/droplets/$droplet_id" "${AUTH[@]}")"
  [[ "$(jq -r '.droplet.status' <<<"$status_response")" == "active" ]] && break
done
[[ "$(jq -r '.droplet.status' <<<"$status_response")" == "active" ]] || { echo "error: observability droplet did not become active" >&2; exit 1; }

public_ip="$(jq -r '[.droplet.networks.v4[] | select(.type=="public")][0].ip_address // empty' <<<"$status_response")"
private_ip="$(jq -r '[.droplet.networks.v4[] | select(.type=="private")][0].ip_address // empty' <<<"$status_response")"
printf 'Observability host active.\nPublic IPv4: %s\nPrivate IPv4: %s\nDroplet ID: %s\n' "$public_ip" "$private_ip" "$droplet_id"
