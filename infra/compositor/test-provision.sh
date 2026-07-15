#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

request="$TEST_ROOT/request.json"
"$SCRIPT_DIR/provision.sh" --name bvm-compositor-e --dry-run >"$request" 2>"$TEST_ROOT/dry-run.err"
jq -e '
  .name == "bvm-compositor-e" and
  .region == "sfo2" and
  .size == "c-4" and
  .tags == ["bvm-compositor"]
' "$request" >/dev/null

if "$SCRIPT_DIR/provision.sh" --name bvm-compositor-unknown --dry-run >/dev/null 2>&1; then
  echo "FAIL: unknown compositor pool slot was accepted" >&2
  exit 1
fi

if "$SCRIPT_DIR/provision.sh" \
  --name bvm-compositor-e \
  --ssh-key 123 \
  --ssh-private-key "$TEST_ROOT/key" \
  --courts 6 \
  --observability-private-ip 10.0.0.10 \
  --register-monitoring \
  --dry-run >/dev/null 2>&1; then
  echo "FAIL: mismatched court assignment was accepted" >&2
  exit 1
fi

if "$SCRIPT_DIR/provision.sh" \
  --name bvm-compositor-spare \
  --ssh-key 123 \
  --ssh-private-key "$TEST_ROOT/key" \
  --courts 1 \
  --observability-private-ip 10.0.0.10 \
  --register-monitoring \
  --dry-run >/dev/null 2>&1; then
  echo "FAIL: unassigned warm spare was registered to a court" >&2
  exit 1
fi

if "$SCRIPT_DIR/provision.sh" --name bvm-compositor-e --size c-8 --dry-run >/dev/null 2>&1; then
  echo "FAIL: pool slot accepted a nonqualified worker shape" >&2
  exit 1
fi

stub_bin="$TEST_ROOT/stub-bin"
mkdir -p "$stub_bin"
cat >"$stub_bin/node" <<'NODE'
#!/usr/bin/env bash
post_create=0
if [[ -n "${MOCK_NODE_STATE:-}" ]]; then
  calls=0
  [[ ! -f "$MOCK_NODE_STATE" ]] || calls="$(cat "$MOCK_NODE_STATE")"
  calls=$((calls + 1))
  printf '%s\n' "$calls" >"$MOCK_NODE_STATE"
  if [[ "${MOCK_POST_SUCCESS:-0}" == "1" && "$calls" -ge 3 ]]; then post_create=1; fi
fi
if [[ "$post_create" -eq 1 ]]; then
cat <<'JSON'
{
  "status": "PASS",
  "account": { "status": "active", "currentDroplets": 8, "dropletLimit": 12, "freeSlots": 4 },
  "compositors": {
    "matchingActive": 5,
    "target": 9,
    "additionsRequired": 4,
    "totalDropletsAfterProvisioning": 12,
    "exactPlan": {
      "matchedNames": ["bvm-compositor-a", "bvm-compositor-b", "bvm-compositor-c", "bvm-compositor-d", "bvm-compositor-e"],
      "missingSlots": [
        { "name": "bvm-compositor-f", "court": 6 },
        { "name": "bvm-compositor-g", "court": 7 },
        { "name": "bvm-compositor-h", "court": 8 },
        { "name": "bvm-compositor-spare", "warmSpare": true }
      ]
    }
  },
  "blockers": []
}
JSON
exit 0
fi
cat <<'JSON'
{
  "status": "PASS",
  "account": { "status": "active", "currentDroplets": 7, "dropletLimit": 12, "freeSlots": 5 },
  "compositors": {
    "matchingActive": 4,
    "target": 9,
    "additionsRequired": 5,
    "totalDropletsAfterProvisioning": 12,
    "exactPlan": {
      "matchedNames": ["bvm-compositor-a", "bvm-compositor-b", "bvm-compositor-c", "bvm-compositor-d"],
      "missingSlots": [
        { "name": "bvm-compositor-e", "court": 5 },
        { "name": "bvm-compositor-f", "court": 6 },
        { "name": "bvm-compositor-g", "court": 7 },
        { "name": "bvm-compositor-h", "court": 8 },
        { "name": "bvm-compositor-spare", "warmSpare": true }
      ]
    }
  },
  "blockers": []
}
JSON
NODE
cat >"$stub_bin/curl" <<'CURL'
#!/usr/bin/env bash
method=GET
output=""
url=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "-X" ]]; then method="$argument"; fi
  if [[ "$previous" == "-o" ]]; then output="$argument"; fi
  if [[ "$argument" == http://* || "$argument" == https://* ]]; then url="$argument"; fi
  previous="$argument"
done
printf '%s %s\n' "$method" "$url" >>"$MOCK_CURL_LOG"
if [[ "$method" == "POST" && "$url" == */tags ]]; then
  [[ -z "$output" ]] || printf '{}\n' >"$output"
  printf '%s' "${MOCK_LOCK_STATUS:-201}"
elif [[ "$method" == "GET" && "$url" == */tags/* ]]; then
  printf '200'
elif [[ "$method" == "DELETE" && "$url" == */tags/* ]]; then
  printf '204'
elif [[ "$method" == "POST" && "$url" == */droplets ]]; then
  if [[ "${MOCK_CREATE_STATUS:-400}" == "202" ]]; then
    [[ -z "$output" ]] || printf '{"droplet":{"id":55}}\n' >"$output"
  else
    [[ -z "$output" ]] || printf '{"accepted":false}\n' >"$output"
  fi
  printf '%s' "${MOCK_CREATE_STATUS:-400}"
elif [[ "$method" == "GET" && "$url" == */droplets/55 ]]; then
  printf '%s\n' '{"droplet":{"id":55,"name":"bvm-compositor-e","status":"active","networks":{"v4":[{"type":"public","ip_address":"192.0.2.10"},{"type":"private","ip_address":"10.0.0.55"}]}}}'
else
  printf '500'
fi
CURL
chmod +x "$stub_bin/node" "$stub_bin/curl"

curl_log="$TEST_ROOT/curl.log"
: >"$curl_log"
if DIGITALOCEAN_TOKEN=test-token \
  SCORECHECK_DO_API_BASE=https://mock.invalid/v2 \
  MOCK_CURL_LOG="$curl_log" \
  PATH="$stub_bin:$PATH" \
  "$SCRIPT_DIR/provision.sh" --name bvm-compositor-e >/dev/null 2>&1; then
  echo "FAIL: real create without a registered SSH key was accepted" >&2
  exit 1
fi
[[ ! -s "$curl_log" ]] || {
  echo "FAIL: provider API was called before SSH-key validation" >&2
  exit 1
}

: >"$curl_log"
if DIGITALOCEAN_TOKEN=test-token \
  SCORECHECK_DO_API_BASE=https://mock.invalid/v2 \
  MOCK_CURL_LOG="$curl_log" \
  PATH="$stub_bin:$PATH" \
  "$SCRIPT_DIR/provision.sh" --name bvm-compositor-e --ssh-key 123 >/dev/null 2>&1; then
  echo "FAIL: mocked failed create unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'POST https://mock.invalid/v2/tags' "$curl_log"
grep -Fq 'POST https://mock.invalid/v2/droplets' "$curl_log"
grep -Fq 'DELETE https://mock.invalid/v2/tags/scorecheck-lock%3Acompositor-pool' "$curl_log"

: >"$curl_log"
if DIGITALOCEAN_TOKEN=test-token \
  SCORECHECK_DO_API_BASE=https://mock.invalid/v2 \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_CREATE_STATUS=500 \
  PATH="$stub_bin:$PATH" \
  "$SCRIPT_DIR/provision.sh" --name bvm-compositor-e --ssh-key 123 >/dev/null 2>&1; then
  echo "FAIL: ambiguous create outcome unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'POST https://mock.invalid/v2/droplets' "$curl_log"
if grep -Fq 'DELETE https://mock.invalid/v2/tags/scorecheck-lock%3Acompositor-pool' "$curl_log"; then
  echo "FAIL: provisioning lock was released after an ambiguous provider outcome" >&2
  exit 1
fi

: >"$curl_log"
if DIGITALOCEAN_TOKEN=test-token \
  SCORECHECK_DO_API_BASE=https://mock.invalid/v2 \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_LOCK_STATUS=422 \
  PATH="$stub_bin:$PATH" \
  "$SCRIPT_DIR/provision.sh" --name bvm-compositor-e --ssh-key 123 >/dev/null 2>&1; then
  echo "FAIL: an existing remote provisioning lock was ignored" >&2
  exit 1
fi
grep -Fq 'GET https://mock.invalid/v2/tags/scorecheck-lock%3Acompositor-pool' "$curl_log"
if grep -Fq 'POST https://mock.invalid/v2/droplets' "$curl_log"; then
  echo "FAIL: droplet create was attempted while the remote lock was held" >&2
  exit 1
fi

: >"$curl_log"
node_state="$TEST_ROOT/node-state"
success_output="$TEST_ROOT/success.out"
if ! DIGITALOCEAN_TOKEN=test-token \
  SCORECHECK_DO_API_BASE=https://mock.invalid/v2 \
  MOCK_CURL_LOG="$curl_log" \
  MOCK_CREATE_STATUS=202 \
  MOCK_NODE_STATE="$node_state" \
  MOCK_POST_SUCCESS=1 \
  PATH="$stub_bin:$PATH" \
  "$SCRIPT_DIR/provision.sh" --name bvm-compositor-e --ssh-key 123 >"$success_output" 2>&1; then
  echo "FAIL: mocked exact-slot create and post-verification failed" >&2
  cat "$success_output" >&2
  exit 1
fi
grep -Fq 'GET https://mock.invalid/v2/droplets/55' "$curl_log"
grep -Fq 'DELETE https://mock.invalid/v2/tags/scorecheck-lock%3Acompositor-pool' "$curl_log"
grep -Fq 'pool remains INCOMPLETE with 4 approved slot(s) missing' "$success_output"

echo "PASS: provisioner admits exact slots, serializes creates, and releases its remote lock"
