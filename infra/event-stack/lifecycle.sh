#!/usr/bin/env bash

set -euo pipefail

API="${SCORECHECK_DO_API_BASE:-https://api.digitalocean.com/v2}"
SSH_KEY="${SCORECHECK_EVENT_SSH_KEY:-$HOME/.ssh/scorecheck_do}"

usage() {
  cat <<'USAGE'
Usage:
  DIGITALOCEAN_TOKEN=... ./lifecycle.sh inventory --manifest EVENT.json
  DIGITALOCEAN_TOKEN=... ./lifecycle.sh adopt --manifest EVENT.json [--dry-run]
  DIGITALOCEAN_TOKEN=... ./lifecycle.sh evidence --manifest EVENT.json --output DIRECTORY
  DIGITALOCEAN_TOKEN=... ./lifecycle.sh destroy --manifest EVENT.json \
    --evidence DIRECTORY --confirm DESTROY:EVENT_SLUG

The manifest must contain:
  event         lowercase event slug
  destroyAfter  YYYY-MM-DD operator review date
  droplets      non-empty array of exact DigitalOcean droplet names and roles

Destroy is never scheduled. It requires protected evidence and an exact typed
confirmation every time. Powering a droplet off is not a teardown operation.
USAGE
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_tools() {
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v jq >/dev/null 2>&1 || die "jq is required"
}

validate_manifest() {
  local manifest="$1"
  [[ -f "$manifest" ]] || die "manifest not found: $manifest"
  jq -e '
    (.event | type == "string" and test("^[a-z0-9][a-z0-9-]{0,62}$")) and
    (.destroyAfter | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")) and
    (.droplets | type == "array" and length > 0) and
    (all(.droplets[]; (.name | type == "string" and length > 0) and (.role | type == "string" and length > 0))) and
    (([.droplets[].name] | unique | length) == (.droplets | length))
  ' "$manifest" >/dev/null || die "invalid event manifest: $manifest"
}

event_tag() {
  printf 'scorecheck-event:%s' "$1"
}

destroy_tag() {
  printf 'scorecheck-destroy-after:%s' "$1"
}

encode() {
  jq -rn --arg value "$1" '$value | @uri'
}

auth_headers() {
  : "${DIGITALOCEAN_TOKEN:?DIGITALOCEAN_TOKEN is required}"
}

list_all_droplets() {
  curl -fsS "$API/droplets?per_page=200" \
    -H "Authorization: Bearer $DIGITALOCEAN_TOKEN"
}

list_event_droplets() {
  local tag="$1"
  curl -fsSG "$API/droplets" \
    -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
    --data-urlencode "tag_name=$tag" \
    --data-urlencode "per_page=200"
}

ensure_tag() {
  local tag="$1"
  local encoded response_file status
  response_file="$(mktemp)"
  status="$(curl -sS -o "$response_file" -w '%{http_code}' -X POST "$API/tags" \
    -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn --arg name "$tag" '{name:$name}')")"
  case "$status" in
    201) ;;
    422)
      encoded="$(encode "$tag")"
      status="$(curl -sS -o /dev/null -w '%{http_code}' "$API/tags/$encoded" \
        -H "Authorization: Bearer $DIGITALOCEAN_TOKEN")"
      [[ "$status" == "200" ]] \
        || { rm -f "$response_file"; die "tag validation failed for $tag (HTTP $status)"; }
      ;;
    *) cat "$response_file" >&2; rm -f "$response_file"; die "could not create tag $tag (HTTP $status)" ;;
  esac
  rm -f "$response_file"
}

tag_droplet() {
  local tag="$1"
  local droplet_id="$2"
  local encoded status
  encoded="$(encode "$tag")"
  status="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API/tags/$encoded/resources" \
    -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -cn --arg id "$droplet_id" '{resources:[{resource_id:$id,resource_type:"droplet"}]}')")"
  [[ "$status" == "204" ]] || die "could not tag droplet $droplet_id with $tag (HTTP $status)"
}

inventory() {
  local manifest="$1"
  local event tag response hourly monthly
  event="$(jq -r '.event' "$manifest")"
  tag="$(event_tag "$event")"
  response="$(list_event_droplets "$tag")"
  hourly="$(jq '[.droplets[].size.price_hourly // 0] | add // 0' <<<"$response")"
  monthly="$(jq '[.droplets[].size.price_monthly // 0] | add // 0' <<<"$response")"

  printf 'Event: %s\nTag: %s\n' "$event" "$tag"
  jq -r '.droplets[] | [.name,.status,.size_slug,(.size.price_hourly|tostring),(.size.price_monthly|tostring),([.networks.v4[]? | select(.type=="public") | .ip_address][0] // "-")] | @tsv' <<<"$response" \
    | awk 'BEGIN {print "NAME\tSTATUS\tSIZE\tHOURLY\tMONTHLY\tPUBLIC_IP"} {print}'
  printf 'Total hourly: $%.4f\nTotal monthly equivalent: $%.2f\n' "$hourly" "$monthly"
  awk -v hourly="$hourly" 'BEGIN {
    printf "Estimated 72 hours: $%.2f\n", hourly * 72;
    printf "Estimated 96 hours: $%.2f\n", hourly * 96;
    printf "Estimated 120 hours: $%.2f\n", hourly * 120;
  }'
}

adopt() {
  local manifest="$1"
  local dry_run="$2"
  local event destroy_after event_label destroy_label temporary_label all name id existing_event_tag
  event="$(jq -r '.event' "$manifest")"
  destroy_after="$(jq -r '.destroyAfter' "$manifest")"
  event_label="$(event_tag "$event")"
  destroy_label="$(destroy_tag "$destroy_after")"
  temporary_label="scorecheck-temporary"
  all="$(list_all_droplets)"

  while IFS= read -r name; do
    id="$(jq -r --arg name "$name" '[.droplets[] | select(.name==$name) | .id] | if length==1 then .[0] else empty end' <<<"$all")"
    [[ -n "$id" ]] || die "expected exactly one active account droplet named $name"
    existing_event_tag="$(jq -r --arg name "$name" '.droplets[] | select(.name==$name) | [.tags[]? | select(startswith("scorecheck-event:"))][0] // empty' <<<"$all")"
    [[ -z "$existing_event_tag" || "$existing_event_tag" == "$event_label" ]] \
      || die "$name already belongs to $existing_event_tag"
    printf '%s\t%s\n' "$name" "$id"
  done < <(jq -r '.droplets[].name' "$manifest")

  if [[ "$dry_run" == "1" ]]; then
    printf 'dry-run tags: %s, %s, %s\n' "$event_label" "$destroy_label" "$temporary_label"
    return
  fi

  ensure_tag "$event_label"
  ensure_tag "$destroy_label"
  ensure_tag "$temporary_label"
  while IFS=$'\t' read -r name id; do
    tag_droplet "$event_label" "$id"
    tag_droplet "$destroy_label" "$id"
    tag_droplet "$temporary_label" "$id"
    echo "tagged $name"
  done < <(
    jq -r '.droplets[].name' "$manifest" | while IFS= read -r name; do
      id="$(jq -r --arg name "$name" '.droplets[] | select(.name==$name) | .id' <<<"$all")"
      printf '%s\t%s\n' "$name" "$id"
    done
  )
}

capture_evidence() {
  local manifest="$1"
  local output="$2"
  local event tag response failures name ip host_file
  event="$(jq -r '.event' "$manifest")"
  tag="$(event_tag "$event")"
  response="$(list_event_droplets "$tag")"
  [[ "$(jq '.droplets | length' <<<"$response")" -gt 0 ]] || die "no droplets found for $tag"

  umask 077
  mkdir -p "$output/hosts"
  printf '%s\n' "$response" >"$output/digitalocean-inventory.json"
  jq -r '.droplets[] | [.id,.name,.status,.size_slug,.created_at,([.networks.v4[]? | select(.type=="public") | .ip_address][0] // "-")] | @tsv' <<<"$response" \
    >"$output/droplets.tsv"
  failures=0
  while IFS=$'\t' read -r name ip; do
    host_file="$output/hosts/$name.txt"
    if [[ "$ip" == "-" ]]; then
      echo "no public address" >"$host_file"
      failures=$((failures + 1))
      continue
    fi
    if ! ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 "root@$ip" '
      set -eu
      date -u
      uptime
      df -Ph /
      free -m
      if command -v docker >/dev/null 2>&1; then
        docker ps --format "{{.Names}}\t{{.Status}}"
        docker stats --no-stream --format "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}"
      fi
    ' >"$host_file" 2>&1; then
      failures=$((failures + 1))
    fi
  done < <(jq -r '.droplets[] | [.name,([.networks.v4[]? | select(.type=="public") | .ip_address][0] // "-")] | @tsv' <<<"$response")

  cp "$manifest" "$output/event-manifest.json"
  if [[ "$failures" -ne 0 ]]; then
    echo "evidence capture incomplete: $failures host(s) failed" >&2
    exit 1
  fi
  printf 'event=%s\ncaptured_at=%s\n' "$event" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >"$output/EVIDENCE_COMPLETE"
  echo "evidence captured in $output"
}

destroy_stack() {
  local manifest="$1"
  local evidence="$2"
  local confirmation="$3"
  local event destroy_after event_label destroy_label response count status remaining
  event="$(jq -r '.event' "$manifest")"
  destroy_after="$(jq -r '.destroyAfter' "$manifest")"
  event_label="$(event_tag "$event")"
  destroy_label="$(destroy_tag "$destroy_after")"
  [[ "$confirmation" == "DESTROY:$event" ]] || die "confirmation must be exactly DESTROY:$event"
  [[ -f "$evidence/EVIDENCE_COMPLETE" ]] || die "protected evidence is incomplete: $evidence"
  grep -qx "event=$event" "$evidence/EVIDENCE_COMPLETE" || die "evidence belongs to a different event"

  response="$(list_event_droplets "$event_label")"
  count="$(jq '.droplets | length' <<<"$response")"
  [[ "$count" -gt 0 ]] || { echo "no droplets found for $event_label"; return; }
  jq -e --arg destroy "$destroy_label" 'all(.droplets[]; (.tags | index("scorecheck-temporary")) and (.tags | index($destroy)))' <<<"$response" >/dev/null \
    || die "one or more event droplets lack temporary/destroy-date safety tags"

  jq -r '.droplets[] | "destroying \(.name) id=\(.id)"' <<<"$response"
  status="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$API/droplets" \
    -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
    -G --data-urlencode "tag_name=$event_label")"
  [[ "$status" == "204" ]] || die "DigitalOcean tag deletion failed (HTTP $status)"

  for _ in $(seq 1 30); do
    sleep 5
    remaining="$(list_event_droplets "$event_label" | jq '.droplets | length')"
    [[ "$remaining" == "0" ]] && { echo "event infrastructure destroyed"; return; }
  done
  die "$remaining droplet(s) still present after destroy request"
}

main() {
  local command_name manifest output evidence confirmation dry_run
  require_tools
  command_name="${1:-}"
  [[ -n "$command_name" ]] || { usage; exit 64; }
  shift || true
  manifest=""
  output=""
  evidence=""
  confirmation=""
  dry_run=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --manifest) manifest="$2"; shift 2 ;;
      --output) output="$2"; shift 2 ;;
      --evidence) evidence="$2"; shift 2 ;;
      --confirm) confirmation="$2"; shift 2 ;;
      --dry-run) dry_run=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $1" ;;
    esac
  done

  case "$command_name" in
    help|-h|--help) usage ;;
    inventory)
      [[ -n "$manifest" ]] || die "--manifest is required"
      validate_manifest "$manifest"
      auth_headers
      inventory "$manifest"
      ;;
    adopt)
      [[ -n "$manifest" ]] || die "--manifest is required"
      validate_manifest "$manifest"
      auth_headers
      adopt "$manifest" "$dry_run"
      ;;
    evidence)
      [[ -n "$manifest" && -n "$output" ]] || die "--manifest and --output are required"
      validate_manifest "$manifest"
      auth_headers
      capture_evidence "$manifest" "$output"
      ;;
    destroy)
      [[ -n "$manifest" && -n "$evidence" ]] || die "--manifest and --evidence are required"
      validate_manifest "$manifest"
      auth_headers
      destroy_stack "$manifest" "$evidence" "$confirmation"
      ;;
    *) die "unknown command: $command_name" ;;
  esac
}

main "$@"
