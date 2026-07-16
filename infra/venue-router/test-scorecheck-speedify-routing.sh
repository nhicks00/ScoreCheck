#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROUTING_TOOL="$SCRIPT_DIR/scorecheck-speedify-routing.sh"
RECORDER="$SCRIPT_DIR/scorecheck-speedify-soak-recorder.sh"
INGEST_IP="138.197.236.201"
TEST_ROOT="$(mktemp -d)"
MOCK_BIN="$TEST_ROOT/bin"
MOCK_STATE="$TEST_ROOT/state"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

mkdir -p "$MOCK_BIN" "$MOCK_STATE"
touch "$MOCK_STATE/rules"

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

grep -Fq "INGEST_IP=\"\${SCORECHECK_INGEST_IP:-$INGEST_IP}\"" "$ROUTING_TOOL" \
  || fail "routing tool default ingest endpoint does not match the retained anchor"
grep -Fq "INGEST_IP=\"\${SCORECHECK_INGEST_IP:-$INGEST_IP}\"" "$RECORDER" \
  || fail "soak recorder default ingest endpoint does not match the retained anchor"

assert_contains() {
  file="$1"
  pattern="$2"
  grep -Eq "$pattern" "$file" || fail "$file does not contain $pattern"
}

assert_rule_count() {
  table="$1"
  expected="$2"
  actual="$(awk -v table="$table" '$0 ~ ("lookup " table "$") {count++} END {print count + 0}' "$MOCK_STATE/rules")"
  [ "$actual" -eq "$expected" ] || fail "table $table has $actual rules, expected $expected"
}

cat >"$MOCK_BIN/ip" <<'MOCK'
#!/bin/sh
set -eu
state="$MOCK_STATE"
printf '%s\n' "$*" >>"$state/ip.log"

value_after() {
  target="$1"
  shift
  previous=""
  for value in "$@"; do
    if [ "$previous" = "$target" ]; then printf '%s' "$value"; return; fi
    previous="$value"
  done
}

if [ "${1:-}" = "rule" ] && [ "${2:-}" = "show" ]; then
  sort -n "$state/rules"
elif [ "${1:-}" = "rule" ] && [ "${2:-}" = "add" ]; then
  pref="$(value_after pref "$@")"
  destination="$(value_after to "$@")"
  protocol="$(value_after ipproto "$@")"
  port="$(value_after dport "$@")"
  table="$(value_after lookup "$@")"
  printf '%s: from all to %s ipproto %s dport %s lookup %s\n' \
    "$pref" "${destination%/32}" "$protocol" "$port" "$table" >>"$state/rules"
elif [ "${1:-}" = "rule" ] && [ "${2:-}" = "del" ]; then
  pref="$(value_after pref "$@")"
  awk -v pref="${pref}:" '$1 != pref' "$state/rules" >"$state/rules.tmp"
  mv "$state/rules.tmp" "$state/rules"
elif [ "${1:-}" = "route" ] && [ "${2:-}" = "replace" ]; then
  table="$(value_after table "$@")"
  if printf '%s\n' "$*" | grep -q 'blackhole default'; then
    printf 'blackhole default\n' >"$state/route.$table"
  else
    dev="$(value_after dev "$@")"
    source="$(value_after src "$@")"
    printf 'default dev %s scope link src %s\n' "$dev" "$source" >"$state/route.$table"
  fi
elif [ "${1:-}" = "route" ] && [ "${2:-}" = "show" ]; then
  table="$(value_after table "$@")"
  cat "$state/route.$table" 2>/dev/null || true
elif [ "${1:-}" = "route" ] && [ "${2:-}" = "flush" ]; then
  table="$(value_after table "$@")"
  : >"$state/route.$table"
elif [ "${1:-}" = "route" ] && [ "${2:-}" = "get" ]; then
  destination="${3:-}"
  protocol="$(value_after ipproto "$@")"
  port="$(value_after dport "$@")"
  if grep -q "ipproto $protocol dport $port lookup 900$" "$state/rules" \
    && grep -q '^default dev connectify0 ' "$state/route.900" 2>/dev/null; then
    printf '%s dev connectify0 table 900 src 10.0.0.2\n' "$destination"
  elif grep -q "ipproto $protocol dport $port lookup 901$" "$state/rules"; then
    exit 2
  else
    printf '%s dev rmnet_mhi0 table main src 192.0.2.2\n' "$destination"
  fi
elif [ "${1:-}" = "link" ] && [ "${2:-}" = "show" ]; then
  [ -f "$state/interface-up" ] || exit 1
  printf '9: connectify0: <UP>\n'
elif [ "${1:-}" = "-4" ] && [ "${2:-}" = "-o" ] && [ "${3:-}" = "addr" ]; then
  [ -f "$state/interface-up" ] || exit 1
  printf '9: connectify0 inet 10.0.0.2/24 scope global connectify0\n'
else
  printf 'unsupported mock ip command: %s\n' "$*" >&2
  exit 64
fi
MOCK

cat >"$MOCK_BIN/iptables" <<'MOCK'
#!/bin/sh
set -eu
state="$MOCK_STATE"
command="${1:-}"
chain="${2:-}"
shift 2 || true
rules="$state/iptables.rules"
jump="$state/iptables.jump"

case "$command:$chain" in
  -N:*)
    [ ! -f "$state/iptables.chain" ] || exit 1
    touch "$state/iptables.chain" "$rules"
    ;;
  -S:*)
    [ -f "$state/iptables.chain" ] || exit 1
    printf '%s\n' "-N $chain"
    while IFS= read -r rule; do [ -n "$rule" ] && printf '%s\n' "-A $chain $rule"; done <"$rules"
    ;;
  -C:forwarding_rule)
    [ "${1:-}" = "-j" ] && [ "${2:-}" = "SCORECHECK_CAMERA_EGRESS" ] && [ -f "$jump" ]
    ;;
  -C:*)
    expected="$*"
    grep -Fxq "$expected" "$rules"
    ;;
  -F:*)
    : >"$rules"
    ;;
  -A:*)
    printf '%s\n' "$*" >>"$rules"
    ;;
  -L:forwarding_rule)
    printf 'Chain forwarding_rule\nnum target prot opt source destination\n'
    [ -f "$jump" ] && printf '1 SCORECHECK_CAMERA_EGRESS all -- 0.0.0.0/0 0.0.0.0/0\n'
    ;;
  -I:forwarding_rule)
    touch "$jump"
    ;;
  -D:forwarding_rule)
    rm -f "$jump"
    ;;
  -X:*)
    rm -f "$state/iptables.chain" "$rules"
    ;;
  *)
    printf 'unsupported mock iptables command: %s %s %s\n' "$command" "$chain" "$*" >&2
    exit 64
    ;;
esac
MOCK

cat >"$MOCK_BIN/speedify_cli" <<'MOCK'
#!/bin/sh
set -eu
state="$MOCK_STATE"
printf '%s\n' "$*" >>"$state/speedify.log"
if [ "${1:-}" = "-s" ] && [ "${2:-}" = "state" ]; then
  value="$(cat "$state/speedify.state" 2>/dev/null || printf 'LOGGED_IN')"
  printf '{"state":"%s"}\n' "$value"
elif [ "${1:-}" = "connect" ]; then
  if [ "${MOCK_SPEEDIFY_AUTO_CONNECT:-0}" -eq 1 ]; then
    printf 'CONNECTED\n' >"$state/speedify.state"
    touch "$state/interface-up"
  fi
elif [ "${1:-}" = "disconnect" ]; then
  printf 'LOGGED_IN\n' >"$state/speedify.state"
  rm -f "$state/interface-up"
else
  exit 0
fi
MOCK

cat >"$MOCK_BIN/conntrack" <<'MOCK'
#!/bin/sh
set -eu
state="$MOCK_STATE"
if [ "${1:-}" = "-L" ]; then
  [ ! -f "$state/active-flows" ] || printf 'udp dport=8890\ntcp dport=1935\n'
elif [ "${1:-}" = "-D" ]; then
  printf '%s\n' "$*" >>"$state/conntrack.log"
  rm -f "$state/active-flows"
fi
MOCK

cat >"$MOCK_BIN/logger" <<'MOCK'
#!/bin/sh
exit 0
MOCK

cat >"$MOCK_BIN/flock" <<'MOCK'
#!/bin/sh
# The router provides util-linux flock. Unit tests are single-process, so the
# mock only needs to acknowledge the already-open lock file descriptor.
[ ! -f "$MOCK_STATE/flock-deny" ] || exit 1
exit 0
MOCK

chmod 0755 "$MOCK_BIN"/*

export MOCK_STATE
export PATH="$MOCK_BIN:$PATH"
export SCORECHECK_SPEEDIFY_ENABLED_FILE="$MOCK_STATE/enabled"
export SCORECHECK_SPEEDIFY_RUNTIME_DIR="$MOCK_STATE/runtime"
export SCORECHECK_SPEEDIFY_WATCH_LOCK_FILE="$MOCK_STATE/watch.lock"
export SCORECHECK_SPEEDIFY_WATCH_PID_FILE="$MOCK_STATE/watch.pid"
export SCORECHECK_SPEEDIFY_CONNECT_RETRY_SECONDS=15
printf 'validated_upload_mbps=85\n' >"$SCORECHECK_SPEEDIFY_ENABLED_FILE"

# A disconnected router installs both independent fail-closed controls.
"$ROUTING_TOOL" guard-if-enabled
assert_rule_count 901 2
assert_contains "$MOCK_STATE/route.901" '^blackhole default$'
[ -f "$MOCK_STATE/iptables.jump" ] || fail "firewall chain is not attached"
assert_contains "$MOCK_STATE/iptables.rules" 'dport 8890 ! -o connectify0 -j REJECT$'
assert_contains "$MOCK_STATE/iptables.rules" 'dport 1935 ! -o connectify0 -j REJECT --reject-with tcp-reset$'

# Once Speedify is healthy, reconciliation adds the primary path and clears
# only stale camera connections.
printf '702: from all to %s ipproto udp dport 8890 lookup 900\n' "$INGEST_IP" >>"$MOCK_STATE/rules"
printf 'CONNECTED\n' >"$MOCK_STATE/speedify.state"
touch "$MOCK_STATE/interface-up" "$MOCK_STATE/active-flows"
"$ROUTING_TOOL" reconcile-once
assert_rule_count 900 2
assert_rule_count 901 2
assert_contains "$MOCK_STATE/route.900" '^default dev connectify0 .*src 10\.0\.0\.2$'
assert_contains "$MOCK_STATE/conntrack.log" '^-D -d 138\.197\.236\.201$'

# A daemon/interface loss removes the primary path but preserves both guards.
printf 'LOGGED_IN\n' >"$MOCK_STATE/speedify.state"
rm -f "$MOCK_STATE/interface-up"
"$ROUTING_TOOL" reconcile-once || true
assert_rule_count 900 0
assert_rule_count 901 2
if ip route get "$INGEST_IP" ipproto udp dport 8890 >/dev/null 2>&1; then
  fail "SRT resolved to a direct route while Speedify was unavailable"
fi

# Event teardown requires both explicit confirmation and zero active flows.
touch "$MOCK_STATE/active-flows"
if "$ROUTING_TOOL" disable EVENT_ENDED >/dev/null 2>&1; then
  fail "disable succeeded while camera flows were active"
fi
[ -f "$SCORECHECK_SPEEDIFY_ENABLED_FILE" ] || fail "failed disable removed enabled state"
rm -f "$MOCK_STATE/active-flows"
"$ROUTING_TOOL" disable EVENT_ENDED >/dev/null
[ ! -f "$SCORECHECK_SPEEDIFY_ENABLED_FILE" ] || fail "disable left enabled state behind"
assert_rule_count 900 0
assert_rule_count 901 0

if "$ROUTING_TOOL" reset >/dev/null 2>&1; then
  fail "obsolete fail-open reset command still exists"
fi

if grep -n '^[[:space:]]*speedify_cli -s stats' "$ROUTING_TOOL" "$RECORDER" >/dev/null; then
  fail "an executable streaming Speedify stats command remains"
fi

# A second lifetime watchdog lock holder exits without reconciling or touching
# enabled state. Real util-linux flock keeps this lock on fd 8 for the loop.
printf 'validated_upload_mbps=85\n' >"$SCORECHECK_SPEEDIFY_ENABLED_FILE"
touch "$MOCK_STATE/flock-deny"
speedify_calls_before="$(wc -l <"$MOCK_STATE/speedify.log")"
"$ROUTING_TOOL" watch >/dev/null
speedify_calls_after="$(wc -l <"$MOCK_STATE/speedify.log")"
[ "$speedify_calls_before" -eq "$speedify_calls_after" ] \
  || fail "duplicate watchdog reconciled while the lifetime lock was held"
[ -f "$SCORECHECK_SPEEDIFY_ENABLED_FILE" ] \
  || fail "duplicate watchdog changed enabled state"
rm -f "$MOCK_STATE/flock-deny"

printf 'PASS: fail-closed routing, recovery, singleton watch, teardown, and monitor leak guards\n'
