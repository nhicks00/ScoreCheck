#!/usr/bin/env bash
# teardown.sh — destroy ALL DigitalOcean droplets tagged `bvm-compositor`.
#
# Usage:
#   DIGITALOCEAN_TOKEN=dop_v1_... ./teardown.sh [--dry-run] [--yes]
#
# Options:
#   --dry-run   print the delete request (and, if a token is set, the droplets
#               that would be destroyed) without deleting anything
#   --yes       skip the interactive confirmation
#
# Scope guard: deletion is strictly by tag (DELETE /v2/droplets?tag_name=...),
# so bvm-preview-01 (MediaMTX, untagged) can never be touched. Snapshots are
# never deleted — they are the ~$1.20/mo idle state (plan §4).

set -euo pipefail

API="https://api.digitalocean.com/v2"
TAG="bvm-compositor"

DRY_RUN=0
ASSUME_YES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown option '$1' (see --help)" >&2; exit 1 ;;
  esac
done

command -v jq >/dev/null 2>&1 || { echo "error: jq is required (brew install jq / apt install jq)" >&2; exit 1; }

if [[ "$DRY_RUN" -eq 1 && -z "${DIGITALOCEAN_TOKEN:-}" ]]; then
  echo "dry-run: would send  DELETE $API/droplets?tag_name=$TAG"
  echo "dry-run: set DIGITALOCEAN_TOKEN to also list the droplets that match."
  exit 0
fi

: "${DIGITALOCEAN_TOKEN:?set DIGITALOCEAN_TOKEN (or use --dry-run for the request shape)}"
AUTH=(-H "Authorization: Bearer $DIGITALOCEAN_TOKEN")

LIST="$(curl -sS "$API/droplets?tag_name=$TAG&per_page=200" "${AUTH[@]}")"
COUNT="$(jq -r '.droplets | length' <<<"$LIST")"

if [[ "$COUNT" == "0" || -z "$COUNT" ]]; then
  echo "no droplets tagged '$TAG' — nothing to tear down."
  exit 0
fi

echo "droplets tagged '$TAG':"
jq -r '.droplets[] | "  id=\(.id)  \(.name)  \(.status)  \([.networks.v4[]? | select(.type == "public") | .ip_address][0] // "-")"' <<<"$LIST"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run: would send  DELETE $API/droplets?tag_name=$TAG  (destroying the $COUNT droplet(s) above)"
  exit 0
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  read -r -p "Destroy the $COUNT droplet(s) above? [y/N] " REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
fi

HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$API/droplets?tag_name=$TAG" "${AUTH[@]}")"
if [[ "$HTTP_CODE" == "204" ]]; then
  echo "destroyed $COUNT droplet(s) tagged '$TAG'. Billing for them stops now."
else
  echo "error: expected HTTP 204 from delete-by-tag, got $HTTP_CODE" >&2
  exit 1
fi
