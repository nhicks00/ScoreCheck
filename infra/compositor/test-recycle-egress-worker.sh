#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/bin" "$FIXTURE/mock" "$FIXTURE/requests"
cp "$SCRIPT_DIR/recycle-egress-worker.sh" "$SCRIPT_DIR/lib.sh" "$FIXTURE/"
printf 'services: {}\n' >"$FIXTURE/docker-compose.yml"
printf '%s\n' \
  'LIVEKIT_API_KEY=test-key' \
  'LIVEKIT_API_SECRET=test-secret-long-enough' >"$FIXTURE/.env"

printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$FIXTURE/bin/flock"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$FIXTURE/bin/sleep"
ln -s "$(command -v jq)" "$FIXTURE/bin/jq"

cat >"$FIXTURE/bin/lk" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "egress list --active --json" ]]
cat "$MOCK_DIR/active.json"
MOCK

cat >"$FIXTURE/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == inspect && "$4" == *'.Id'* ]]; then
  cat "$MOCK_DIR/container-id"
elif [[ "$1" == inspect && "$4" == *Health* ]]; then
  printf 'healthy\n'
elif [[ "$1" == compose ]]; then
  count="$(<"$MOCK_DIR/recreate-count")"
  count=$((count + 1))
  printf '%s\n' "$count" >"$MOCK_DIR/recreate-count"
  printf 'container-%s\n' "$count" >"$MOCK_DIR/container-id"
else
  exit 2
fi
MOCK

cat >"$FIXTURE/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'/metrics'* ]]; then
  cat "$MOCK_DIR/metrics"
else
  printf 'ok\n'
fi
MOCK
chmod 755 "$FIXTURE/bin/flock" "$FIXTURE/bin/sleep" "$FIXTURE/bin/lk" "$FIXTURE/bin/docker" "$FIXTURE/bin/curl"

printf 'null\n' >"$FIXTURE/mock/active.json"
printf '0\n' >"$FIXTURE/mock/recreate-count"
printf 'container-original\n' >"$FIXTURE/mock/container-id"
cat >"$FIXTURE/mock/metrics" <<'METRICS'
livekit_egress_available{node_id="test"} 1
livekit_egress_can_accept_request{node_id="test"} 1
livekit_load_ratio{node_id="test",type="pulse"} 0.05
METRICS

run_recycle() {
  MOCK_DIR="$FIXTURE/mock" PATH="$FIXTURE/bin:$PATH" "$FIXTURE/recycle-egress-worker.sh" >/dev/null
}

run_recycle
grep -Fxq '1' "$FIXTURE/mock/recreate-count"
grep -Fxq 'container-1' "$FIXTURE/mock/container-id"

printf '{}\n' >"$FIXTURE/requests/court-1.owner.json"
if run_recycle 2>/dev/null; then
  echo "FAIL: recycle accepted an output owner" >&2
  exit 1
fi
grep -Fxq '1' "$FIXTURE/mock/recreate-count"
rm "$FIXTURE/requests/court-1.owner.json"

printf '[{"egress_id":"EG_active"}]\n' >"$FIXTURE/mock/active.json"
if run_recycle 2>/dev/null; then
  echo "FAIL: recycle accepted an active Egress" >&2
  exit 1
fi
grep -Fxq '1' "$FIXTURE/mock/recreate-count"

printf 'null\n' >"$FIXTURE/mock/active.json"
cat >"$FIXTURE/mock/metrics" <<'METRICS'
livekit_egress_available{node_id="test"} 1
livekit_egress_can_accept_request{node_id="test"} 1
livekit_load_ratio{node_id="test",type="pulse"} NaN
METRICS
if run_recycle 2>/dev/null; then
  echo "FAIL: recycle accepted malformed native metrics" >&2
  exit 1
fi
grep -Fxq '2' "$FIXTURE/mock/recreate-count"

printf 'PASS: idle Egress worker recycle is ownership-safe and admission-strict\n'
