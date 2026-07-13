#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

source "$SCRIPT_DIR/lifecycle.sh"

manifest="$TEST_ROOT/event.json"
cat >"$manifest" <<'JSON'
{
  "event": "test-event",
  "destroyAfter": "2026-07-13",
  "droplets": [
    { "name": "ingest-1", "role": "ingest" },
    { "name": "compositor-1", "role": "compositor" }
  ]
}
JSON

exact='{"droplets":[{"id":11,"name":"compositor-1"},{"id":10,"name":"ingest-1"}]}'
extra='{"droplets":[{"id":11,"name":"compositor-1"},{"id":10,"name":"ingest-1"},{"id":12,"name":"unrelated"}]}'
missing='{"droplets":[{"id":10,"name":"ingest-1"}]}'
duplicate_id='{"droplets":[{"id":10,"name":"compositor-1"},{"id":10,"name":"ingest-1"}]}'
replacement_id='{"droplets":[{"id":11,"name":"compositor-1"},{"id":99,"name":"ingest-1"}]}'

assert_exact_manifest_inventory "$manifest" "$exact" "test"
if (assert_exact_manifest_inventory "$manifest" "$extra" "test") >/dev/null 2>&1; then
  echo "FAIL: extra tagged droplet was admitted" >&2
  exit 1
fi
if (assert_exact_manifest_inventory "$manifest" "$missing" "test") >/dev/null 2>&1; then
  echo "FAIL: missing manifest droplet was admitted" >&2
  exit 1
fi
if (assert_exact_manifest_inventory "$manifest" "$duplicate_id" "test") >/dev/null 2>&1; then
  echo "FAIL: duplicate droplet ID was admitted" >&2
  exit 1
fi
if (assert_same_inventory_identity "$exact" "$replacement_id") >/dev/null 2>&1; then
  echo "FAIL: replacement droplet ID was admitted against captured evidence" >&2
  exit 1
fi

evidence="$TEST_ROOT/evidence"
mkdir -p "$evidence"
cp "$manifest" "$evidence/event-manifest.json"
printf '%s\n' "$exact" >"$evidence/digitalocean-inventory.json"
printf 'event=test-event\ndroplet_count=2\nmanifest_sha256=%s\ninventory_sha256=%s\n' \
  "$(sha256_file "$evidence/event-manifest.json")" \
  "$(sha256_file "$evidence/digitalocean-inventory.json")" \
  >"$evidence/EVIDENCE_COMPLETE"

[[ "$(evidence_value "$evidence/EVIDENCE_COMPLETE" event)" == "test-event" ]]
[[ "$(evidence_value "$evidence/EVIDENCE_COMPLETE" droplet_count)" == "2" ]]

destroy_inventory='{"droplets":[{"id":11,"name":"compositor-1","tags":["scorecheck-temporary","scorecheck-destroy-after:2026-07-13"]},{"id":10,"name":"ingest-1","tags":["scorecheck-temporary","scorecheck-destroy-after:2026-07-13"]}]}'
delete_log="$TEST_ROOT/deleted-ids"
: >"$delete_log"
export DIGITALOCEAN_TOKEN=test-token
export SCORECHECK_CURRENT_DATE_UTC=2026-07-13

list_event_droplets() {
  if [[ "$(wc -l <"$delete_log")" -ge 2 ]]; then
    printf '%s\n' '{"droplets":[]}'
  else
    printf '%s\n' "$destroy_inventory"
  fi
}

curl() {
  local argument
  for argument in "$@"; do
    case "$argument" in
      "$API/droplets/"*) printf '%s\n' "${argument##*/}" >>"$delete_log" ;;
    esac
  done
  printf '204'
}

sleep() {
  :
}

destroy_stack "$manifest" "$evidence" "DESTROY:test-event" >/dev/null
[[ "$(sort -n "$delete_log" | tr '\n' ' ')" == "10 11 " ]] || {
  echo "FAIL: destroy did not target the two verified IDs" >&2
  exit 1
}

: >"$delete_log"
export SCORECHECK_CURRENT_DATE_UTC=2026-07-12
if (destroy_stack "$manifest" "$evidence" "DESTROY:test-event") >/dev/null 2>&1; then
  echo "FAIL: destroy succeeded before the review date" >&2
  exit 1
fi

grep -Fq '"$API/droplets/$id"' "$SCRIPT_DIR/lifecycle.sh"
if grep -Fq -- '--data-urlencode "tag_name=$event_label"' "$SCRIPT_DIR/lifecycle.sh"; then
  echo "FAIL: tag-wide destroy request remains" >&2
  exit 1
fi

echo "PASS: exact event inventory, evidence integrity, and ID-scoped destroy guards"
