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
  local tool
  for tool in cmp curl jq shasum ssh; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
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

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

manifest_droplet_names() {
  jq -cS '[.droplets[].name] | sort' "$1"
}

inventory_droplet_names() {
  jq -cS '[.droplets[].name] | sort' <<<"$1"
}

inventory_droplet_identities() {
  jq -cS '[.droplets[] | {id,name}] | sort_by(.name,.id)' <<<"$1"
}

assert_exact_manifest_inventory() {
  local manifest="$1"
  local response="$2"
  local context="$3"
  local expected actual
  expected="$(manifest_droplet_names "$manifest")"
  actual="$(inventory_droplet_names "$response")"
  [[ "$actual" == "$expected" ]] || die \
    "$context droplet set does not exactly match the event manifest (expected $expected, found $actual)"
  jq -e '([.droplets[].id] | length) == ([.droplets[].id] | unique | length)' <<<"$response" >/dev/null \
    || die "$context contains duplicate droplet IDs"
}

assert_same_inventory_identity() {
  local captured="$1"
  local current="$2"
  [[ "$(inventory_droplet_identities "$current")" == "$(inventory_droplet_identities "$captured")" ]] \
    || die "current droplet IDs do not match captured evidence"
}

evidence_value() {
  local evidence_file="$1"
  local key="$2"
  sed -n "s/^${key}=//p" "$evidence_file"
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
  assert_exact_manifest_inventory "$manifest" "$response" "tagged inventory"
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
  assert_exact_manifest_inventory "$manifest" "$response" "evidence inventory"

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
  printf 'event=%s\ncaptured_at=%s\ndroplet_count=%s\nmanifest_sha256=%s\ninventory_sha256=%s\n' \
    "$event" \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    "$(jq '.droplets | length' <<<"$response")" \
    "$(sha256_file "$output/event-manifest.json")" \
    "$(sha256_file "$output/digitalocean-inventory.json")" \
    >"$output/EVIDENCE_COMPLETE"
  echo "evidence captured in $output"
}

destroy_stack() {
  local manifest="$1"
  local evidence="$2"
  local confirmation="$3"
  local event destroy_after event_label destroy_label response count status remaining today
  local marker evidence_manifest evidence_inventory expected_sha actual_sha expected_count
  event="$(jq -r '.event' "$manifest")"
  destroy_after="$(jq -r '.destroyAfter' "$manifest")"
  event_label="$(event_tag "$event")"
  destroy_label="$(destroy_tag "$destroy_after")"
  [[ "$confirmation" == "DESTROY:$event" ]] || die "confirmation must be exactly DESTROY:$event"
  today="${SCORECHECK_CURRENT_DATE_UTC:-$(date -u '+%Y-%m-%d')}"
  [[ "$today" < "$destroy_after" ]] \
    && die "destroy review date is $destroy_after; current UTC date is $today"

  marker="$evidence/EVIDENCE_COMPLETE"
  evidence_manifest="$evidence/event-manifest.json"
  evidence_inventory="$evidence/digitalocean-inventory.json"
  [[ -f "$marker" && -f "$evidence_manifest" && -f "$evidence_inventory" ]] \
    || die "protected evidence is incomplete: $evidence"
  [[ "$(evidence_value "$marker" event)" == "$event" ]] || die "evidence belongs to a different event"
  cmp -s "$manifest" "$evidence_manifest" || die "event manifest changed after evidence capture"
  expected_sha="$(evidence_value "$marker" manifest_sha256)"
  actual_sha="$(sha256_file "$evidence_manifest")"
  [[ -n "$expected_sha" && "$actual_sha" == "$expected_sha" ]] || die "evidence manifest integrity check failed"
  expected_sha="$(evidence_value "$marker" inventory_sha256)"
  actual_sha="$(sha256_file "$evidence_inventory")"
  [[ -n "$expected_sha" && "$actual_sha" == "$expected_sha" ]] || die "DigitalOcean evidence integrity check failed"
  assert_exact_manifest_inventory "$manifest" "$(cat "$evidence_inventory")" "captured evidence"

  response="$(list_event_droplets "$event_label")"
  assert_exact_manifest_inventory "$manifest" "$response" "current tagged inventory"
  assert_same_inventory_identity "$(cat "$evidence_inventory")" "$response"
  count="$(jq '.droplets | length' <<<"$response")"
  expected_count="$(evidence_value "$marker" droplet_count)"
  [[ "$expected_count" =~ ^[0-9]+$ && "$count" == "$expected_count" ]] \
    || die "current droplet count does not match captured evidence"
  jq -e --arg destroy "$destroy_label" 'all(.droplets[]; (.tags | index("scorecheck-temporary")) and (.tags | index($destroy)))' <<<"$response" >/dev/null \
    || die "one or more event droplets lack temporary/destroy-date safety tags"

  jq -r '.droplets[] | "destroying \(.name) id=\(.id)"' <<<"$response"
  while IFS=$'\t' read -r id name; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$API/droplets/$id" \
      -H "Authorization: Bearer $DIGITALOCEAN_TOKEN")"
    [[ "$status" == "204" ]] || die "DigitalOcean deletion failed for $name id=$id (HTTP $status)"
  done < <(jq -r '.droplets[] | [.id,.name] | @tsv' <<<"$response")

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

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
