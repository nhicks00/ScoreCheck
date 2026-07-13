#!/bin/sh

set -eu

INGEST_IP="${SCORECHECK_INGEST_IP:-206.189.169.162}"
SPEEDIFY_INTERFACE="${SCORECHECK_SPEEDIFY_INTERFACE:-connectify0}"
PRIMARY_TABLE="${SCORECHECK_SPEEDIFY_ROUTE_TABLE:-900}"
GUARD_TABLE="${SCORECHECK_SPEEDIFY_GUARD_TABLE:-901}"
# These priorities run before Speedify's router safety rules, which begin at 800.
SRT_RULE_PREF="${SCORECHECK_SPEEDIFY_SRT_RULE_PREF:-700}"
RTMP_RULE_PREF="${SCORECHECK_SPEEDIFY_RTMP_RULE_PREF:-701}"
LEGACY_PRIMARY_RULE_PREFS="${SCORECHECK_SPEEDIFY_LEGACY_RULE_PREFS:-702 703 704}"
SRT_GUARD_PREF="${SCORECHECK_SPEEDIFY_SRT_GUARD_PREF:-710}"
RTMP_GUARD_PREF="${SCORECHECK_SPEEDIFY_RTMP_GUARD_PREF:-711}"
MIN_UPLOAD_MBPS="${SCORECHECK_MIN_BONDED_UPLOAD_MBPS:-75}"
ENABLED_FILE="${SCORECHECK_SPEEDIFY_ENABLED_FILE:-/etc/scorecheck-speedify.enabled}"
RUNTIME_DIR="${SCORECHECK_SPEEDIFY_RUNTIME_DIR:-/var/run/scorecheck-speedify}"
LOCK_FILE="$RUNTIME_DIR/reconcile.lock"
WATCH_LOCK_FILE="${SCORECHECK_SPEEDIFY_WATCH_LOCK_FILE:-/var/run/scorecheck-speedify-watch.lock}"
WATCH_PID_FILE="${SCORECHECK_SPEEDIFY_WATCH_PID_FILE:-/var/run/scorecheck-speedify-watch.pid}"
LAST_CONNECT_FILE="$RUNTIME_DIR/last-connect-at"
LAST_STATUS_FILE="$RUNTIME_DIR/last-status"
WATCH_INTERVAL_SECONDS="${SCORECHECK_SPEEDIFY_WATCH_INTERVAL_SECONDS:-5}"
CONNECT_RETRY_SECONDS="${SCORECHECK_SPEEDIFY_CONNECT_RETRY_SECONDS:-15}"
FIREWALL_CHAIN="${SCORECHECK_SPEEDIFY_FIREWALL_CHAIN:-SCORECHECK_CAMERA_EGRESS}"

umask 077

usage() {
  cat <<EOF
Usage: $0 preflight VALIDATED_UPLOAD_MBPS
       $0 enable VALIDATED_UPLOAD_MBPS
       $0 reconcile-once
       $0 guard-if-enabled
       $0 watch
       $0 status
       $0 disable EVENT_ENDED

Camera RTMP/SRT traffic is fail-closed. When Speedify is unavailable, camera
traffic is blocked while the watchdog reconnects it; it never uses a direct WAN.
Ordinary LAN traffic remains outside Speedify.
EOF
}

log() {
  printf '%s\n' "scorecheck-speedify: $*"
  if command -v logger >/dev/null 2>&1; then
    logger -t scorecheck-speedify "$*" 2>/dev/null || true
  fi
}

die() {
  printf '%s\n' "scorecheck-speedify: error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

validate_positive_integer() {
  name="$1"
  value="$2"
  case "$value" in
    ''|*[!0-9]*) die "$name must be a positive integer" ;;
  esac
  [ "$value" -gt 0 ] || die "$name must be a positive integer"
}

validate_capacity() {
  capacity="${1:-}"
  validate_positive_integer "validated upload" "$capacity"
  [ "$capacity" -ge "$MIN_UPLOAD_MBPS" ] || die \
    "validated bonded upload is ${capacity} Mbps; at least ${MIN_UPLOAD_MBPS} Mbps is required"
}

speedify_state() {
  # `-s state` is a bounded one-shot response. Never replace this with the
  # streaming `-s stats` command in a pipeline.
  state="$(speedify_cli -s state 2>/dev/null || true)"
  printf '%s\n' "$state" | sed -n 's/.*"state":"\([^"]*\)".*/\1/p'
}

speedify_is_connected() {
  [ "$(speedify_state)" = "CONNECTED" ]
}

speedify_is_logged_in() {
  state="$(speedify_state)"
  [ "$state" = "LOGGED_IN" ] || [ "$state" = "CONNECTED" ]
}

speedify_interface_ready() {
  ip link show dev "$SPEEDIFY_INTERFACE" >/dev/null 2>&1
}

active_camera_flows() {
  conntrack -L -d "$INGEST_IP" 2>/dev/null | grep -Eq 'dport=(1935|8890)'
}

clear_camera_flows() {
  conntrack -D -d "$INGEST_IP" >/dev/null 2>&1 || true
}

rule_for_pref() {
  pref="$1"
  ip rule show | awk -v target="${pref}:" '$1 == target'
}

rule_matches() {
  pref="$1"
  table="$2"
  protocol="$3"
  port="$4"
  existing="$(rule_for_pref "$pref")"
  [ "$(printf '%s\n' "$existing" | grep -c . || true)" -eq 1 ] \
    && printf '%s\n' "$existing" | grep -q "to $INGEST_IP" \
    && printf '%s\n' "$existing" | grep -q "ipproto $protocol" \
    && printf '%s\n' "$existing" | grep -q "dport $port" \
    && printf '%s\n' "$existing" | grep -q "lookup $table"
}

assert_rule_slot_available() {
  pref="$1"
  owned_table="$2"
  existing="$(rule_for_pref "$pref")"
  if [ -n "$existing" ] && ! printf '%s\n' "$existing" | grep -q "lookup $owned_table"; then
    die "policy priority $pref is owned by another route table: $existing"
  fi
}

remove_owned_rule() {
  pref="$1"
  owned_table="$2"
  existing="$(rule_for_pref "$pref")"
  if [ -n "$existing" ] && ! printf '%s\n' "$existing" | grep -q "lookup $owned_table"; then
    log "left unrelated policy priority $pref unchanged"
    return 0
  fi
  while ip rule show | grep -q "^${pref}:"; do
    ip rule del pref "$pref" 2>/dev/null || break
  done
}

ensure_rule() {
  pref="$1"
  table="$2"
  protocol="$3"
  port="$4"
  if rule_matches "$pref" "$table" "$protocol" "$port"; then
    return 1
  fi
  assert_rule_slot_available "$pref" "$table"
  remove_owned_rule "$pref" "$table"
  ip rule add pref "$pref" to "$INGEST_IP/32" ipproto "$protocol" dport "$port" lookup "$table"
  return 0
}

firewall_rule_count() {
  iptables -S "$FIREWALL_CHAIN" 2>/dev/null | grep -c "^-A $FIREWALL_CHAIN " || true
}

firewall_rules_complete() {
  [ "$(firewall_rule_count)" -eq 3 ] \
    && iptables -C "$FIREWALL_CHAIN" -d "$INGEST_IP/32" -p udp --dport 8890 ! -o "$SPEEDIFY_INTERFACE" -j REJECT >/dev/null 2>&1 \
    && iptables -C "$FIREWALL_CHAIN" -d "$INGEST_IP/32" -p tcp --dport 1935 ! -o "$SPEEDIFY_INTERFACE" -j REJECT --reject-with tcp-reset >/dev/null 2>&1 \
    && iptables -C "$FIREWALL_CHAIN" -j RETURN >/dev/null 2>&1
}

ensure_firewall_guard() {
  iptables -N "$FIREWALL_CHAIN" >/dev/null 2>&1 || true
  if ! firewall_rules_complete; then
    iptables -F "$FIREWALL_CHAIN"
    iptables -A "$FIREWALL_CHAIN" -d "$INGEST_IP/32" -p udp --dport 8890 ! -o "$SPEEDIFY_INTERFACE" -j REJECT
    iptables -A "$FIREWALL_CHAIN" -d "$INGEST_IP/32" -p tcp --dport 1935 ! -o "$SPEEDIFY_INTERFACE" -j REJECT --reject-with tcp-reset
    iptables -A "$FIREWALL_CHAIN" -j RETURN
  fi

  first_target="$(iptables -L forwarding_rule --line-numbers -n 2>/dev/null | awk '$1 == "1" {print $2; exit}')"
  if [ "$first_target" != "$FIREWALL_CHAIN" ]; then
    while iptables -C forwarding_rule -j "$FIREWALL_CHAIN" >/dev/null 2>&1; do
      iptables -D forwarding_rule -j "$FIREWALL_CHAIN"
    done
    iptables -I forwarding_rule 1 -j "$FIREWALL_CHAIN"
  fi
}

remove_firewall_guard() {
  while iptables -C forwarding_rule -j "$FIREWALL_CHAIN" >/dev/null 2>&1; do
    iptables -D forwarding_rule -j "$FIREWALL_CHAIN"
  done
  iptables -F "$FIREWALL_CHAIN" >/dev/null 2>&1 || true
  iptables -X "$FIREWALL_CHAIN" >/dev/null 2>&1 || true
}

ensure_route_guards() {
  guard_route="$(ip route show table "$GUARD_TABLE" 2>/dev/null || true)"
  if ! printf '%s\n' "$guard_route" | grep -q '^blackhole default'; then
    ip route replace blackhole default table "$GUARD_TABLE"
  fi
  ensure_rule "$SRT_GUARD_PREF" "$GUARD_TABLE" udp 8890 || true
  ensure_rule "$RTMP_GUARD_PREF" "$GUARD_TABLE" tcp 1935 || true
  ensure_firewall_guard
}

remove_legacy_primary_rules() {
  for pref in $LEGACY_PRIMARY_RULE_PREFS; do
    remove_owned_rule "$pref" "$PRIMARY_TABLE"
  done
}

drop_primary_routes() {
  remove_owned_rule "$SRT_RULE_PREF" "$PRIMARY_TABLE"
  remove_owned_rule "$RTMP_RULE_PREF" "$PRIMARY_TABLE"
  remove_legacy_primary_rules
  ip route flush table "$PRIMARY_TABLE" 2>/dev/null || true
}

remove_route_guards() {
  remove_owned_rule "$SRT_GUARD_PREF" "$GUARD_TABLE"
  remove_owned_rule "$RTMP_GUARD_PREF" "$GUARD_TABLE"
  ip route flush table "$GUARD_TABLE" 2>/dev/null || true
  remove_firewall_guard
}

tunnel_source() {
  ip -4 -o addr show dev "$SPEEDIFY_INTERFACE" 2>/dev/null \
    | awk 'NR == 1 {split($4, value, "/"); print value[1]}'
}

camera_route_uses_speedify() {
  protocol="$1"
  port="$2"
  route="$(ip route get "$INGEST_IP" ipproto "$protocol" dport "$port" 2>/dev/null || true)"
  printf '%s\n' "$route" | grep -q "dev $SPEEDIFY_INTERFACE" \
    && printf '%s\n' "$route" | grep -q "table $PRIMARY_TABLE"
}

ensure_primary_routes() {
  source_address="$(tunnel_source)"
  [ -n "$source_address" ] || return 1
  changed=0
  for pref in $LEGACY_PRIMARY_RULE_PREFS; do
    if [ -n "$(rule_for_pref "$pref")" ]; then
      remove_owned_rule "$pref" "$PRIMARY_TABLE"
      changed=1
    fi
  done
  primary_route="$(ip route show table "$PRIMARY_TABLE" 2>/dev/null || true)"
  if ! printf '%s\n' "$primary_route" | grep -q "^default dev $SPEEDIFY_INTERFACE .*src $source_address"; then
    ip route replace table "$PRIMARY_TABLE" default dev "$SPEEDIFY_INTERFACE" scope link src "$source_address"
    changed=1
  fi
  if ensure_rule "$SRT_RULE_PREF" "$PRIMARY_TABLE" udp 8890; then changed=1; fi
  if ensure_rule "$RTMP_RULE_PREF" "$PRIMARY_TABLE" tcp 1935; then changed=1; fi

  if ! camera_route_uses_speedify udp 8890 || ! camera_route_uses_speedify tcp 1935; then
    drop_primary_routes
    return 1
  fi
  if [ "$changed" -eq 1 ]; then
    clear_camera_flows
    log "restored camera routes through $SPEEDIFY_INTERFACE and cleared stale camera connections"
  fi
}

configure_speedify() {
  speedify_cli route default off >/dev/null
  speedify_cli mode speed >/dev/null
  speedify_cli transport udp >/dev/null
  speedify_cli targetconnections 0 0 >/dev/null
  speedify_cli pep on >/dev/null
}

set_runtime_status() {
  status="$1"
  mkdir -p "$RUNTIME_DIR"
  previous="$(cat "$LAST_STATUS_FILE" 2>/dev/null || true)"
  printf '%s\n' "$status" >"$LAST_STATUS_FILE"
  if [ "$status" != "$previous" ]; then
    log "state changed: $status"
  fi
}

connect_if_due() {
  now="$(date +%s)"
  last="$(cat "$LAST_CONNECT_FILE" 2>/dev/null || printf '0')"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $((now - last)) -lt "$CONNECT_RETRY_SECONDS" ]; then
    return 0
  fi
  printf '%s\n' "$now" >"$LAST_CONNECT_FILE"
  configure_speedify || true
  speedify_cli connect last >/dev/null 2>&1 || true
  log "requested Speedify reconnect; camera traffic remains blocked until the tunnel is healthy"
}

reconcile_locked() {
  ensure_route_guards || true
  if speedify_is_connected && speedify_interface_ready; then
    if ensure_primary_routes; then
      set_runtime_status "CONNECTED_ROUTED"
      return 0
    fi
    drop_primary_routes
    set_runtime_status "CONNECTED_ROUTE_INVALID_BLOCKED"
    return 1
  fi

  drop_primary_routes
  set_runtime_status "SPEEDIFY_UNAVAILABLE_BLOCKED"
  connect_if_due
  return 1
}

reconcile_once() {
  [ -f "$ENABLED_FILE" ] || return 0
  mkdir -p "$RUNTIME_DIR"
  (
    flock -n 9 || exit 0
    reconcile_locked
  ) 9>"$LOCK_FILE"
}

guard_if_enabled() {
  [ -f "$ENABLED_FILE" ] || return 0
  ensure_route_guards || true
}

preflight() {
  validate_capacity "${1:-}"
  for command in speedify_cli conntrack ip iptables flock; do
    require_command "$command"
  done
  assert_rule_slot_available "$SRT_RULE_PREF" "$PRIMARY_TABLE"
  assert_rule_slot_available "$RTMP_RULE_PREF" "$PRIMARY_TABLE"
  for pref in $LEGACY_PRIMARY_RULE_PREFS; do
    assert_rule_slot_available "$pref" "$PRIMARY_TABLE"
  done
  assert_rule_slot_available "$SRT_GUARD_PREF" "$GUARD_TABLE"
  assert_rule_slot_available "$RTMP_GUARD_PREF" "$GUARD_TABLE"
  speedify_is_logged_in || die "Speedify is not logged in"
  validate_positive_integer "watch interval" "$WATCH_INTERVAL_SECONDS"
  validate_positive_integer "connect retry interval" "$CONNECT_RETRY_SECONDS"
  log "preflight passed with ${1} Mbps validated bonded upload"
}

enable_routes_locked() {
  capacity="${1:-}"
  preflight "$capacity"
  mkdir -p "$RUNTIME_DIR"

  # Install both independent guards before changing any active camera path.
  ensure_route_guards || true
  temporary="$ENABLED_FILE.tmp.$$"
  {
    printf 'validated_upload_mbps=%s\n' "$capacity"
    printf 'minimum_upload_mbps=%s\n' "$MIN_UPLOAD_MBPS"
    printf 'ingest_ip=%s\n' "$INGEST_IP"
    printf 'enabled_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$temporary"
  mv "$temporary" "$ENABLED_FILE"

  configure_speedify
  speedify_cli connect last >/dev/null 2>&1 || true
  printf '%s\n' "$(date +%s)" >"$LAST_CONNECT_FILE"

  attempts=0
  while [ "$attempts" -lt 20 ]; do
    if speedify_is_connected && speedify_interface_ready && ensure_primary_routes; then
      set_runtime_status "CONNECTED_ROUTED"
      log "camera RTMP/SRT traffic is fail-closed through Speedify; ordinary LAN traffic remains direct"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done

  drop_primary_routes
  set_runtime_status "SPEEDIFY_UNAVAILABLE_BLOCKED"
  die "Speedify did not become routable; camera traffic remains blocked and the watchdog will keep retrying"
}

enable_routes() {
  mkdir -p "$RUNTIME_DIR"
  (
    flock 9
    enable_routes_locked "$1"
  ) 9>"$LOCK_FILE"
}

watch_routes() {
  validate_positive_integer "watch interval" "$WATCH_INTERVAL_SECONDS"
  mkdir -p "$(dirname "$WATCH_LOCK_FILE")" "$(dirname "$WATCH_PID_FILE")"
  exec 8>"$WATCH_LOCK_FILE"
  if ! flock -n 8; then
    log "another watchdog owns the lifetime lock; exiting duplicate process"
    return 0
  fi

  watch_pid="$$"
  printf '%s\n' "$watch_pid" >"$WATCH_PID_FILE"
  watch_cleanup() {
    trap - HUP INT TERM EXIT
    if [ "$(cat "$WATCH_PID_FILE" 2>/dev/null || true)" = "$watch_pid" ]; then
      rm -f "$WATCH_PID_FILE"
    fi
  }
  trap watch_cleanup EXIT
  trap 'watch_cleanup; exit 0' HUP INT TERM

  while :; do
    if [ -f "$ENABLED_FILE" ]; then
      reconcile_once || true
    fi
    sleep "$WATCH_INTERVAL_SECONDS"
  done
}

disable_routes_locked() {
  [ "${1:-}" = "EVENT_ENDED" ] || die "disable requires the exact confirmation: EVENT_ENDED"
  if active_camera_flows; then
    die "camera flows are still active; stop publishers and verify event coverage has ended before disabling"
  fi
  rm -f "$ENABLED_FILE"
  drop_primary_routes
  remove_route_guards
  clear_camera_flows
  speedify_cli disconnect >/dev/null 2>&1 || true
  rm -rf "$RUNTIME_DIR"
  log "event-ended confirmation accepted; ScoreCheck routing and guards are disabled"
}

disable_routes() {
  mkdir -p "$RUNTIME_DIR"
  (
    flock 9
    disable_routes_locked "$1"
  ) 9>"$LOCK_FILE"
}

status() {
  enabled="no"
  [ -f "$ENABLED_FILE" ] && enabled="yes"
  printf 'Enabled: %s\n' "$enabled"
  printf 'Speedify state: %s\n' "$(speedify_state || true)"
  printf 'Ingest IP: %s\n' "$INGEST_IP"
  printf 'Runtime status: %s\n' "$(cat "$LAST_STATUS_FILE" 2>/dev/null || printf 'unknown')"
  echo "Policy rules:"
  ip rule show | grep -E "^(${SRT_RULE_PREF}|${RTMP_RULE_PREF}|${SRT_GUARD_PREF}|${RTMP_GUARD_PREF}):" || echo "none"
  echo "Primary route table $PRIMARY_TABLE:"
  ip route show table "$PRIMARY_TABLE" 2>/dev/null || true
  echo "Guard route table $GUARD_TABLE:"
  ip route show table "$GUARD_TABLE" 2>/dev/null || true
  if iptables -C forwarding_rule -j "$FIREWALL_CHAIN" >/dev/null 2>&1 && firewall_rules_complete; then
    echo "Firewall kill switch: active"
  else
    echo "Firewall kill switch: inactive"
  fi
  if [ -f "$ENABLED_FILE" ]; then
    echo "Validated state:"
    cat "$ENABLED_FILE"
  fi
  watchdog_pid="$(cat "$WATCH_PID_FILE" 2>/dev/null || true)"
  case "$watchdog_pid" in
    ''|*[!0-9]*) echo "Watchdog lock owner: none" ;;
    *)
      if kill -0 "$watchdog_pid" 2>/dev/null; then
        printf 'Watchdog lock owner: %s\n' "$watchdog_pid"
      else
        printf 'Watchdog lock owner: stale (%s)\n' "$watchdog_pid"
      fi
      ;;
  esac
}

command="${1:-}"
case "$command" in
  preflight) preflight "${2:-}" ;;
  enable) enable_routes "${2:-}" ;;
  reconcile-once) reconcile_once ;;
  guard-if-enabled) guard_if_enabled ;;
  watch) watch_routes ;;
  status) status ;;
  disable) disable_routes "${2:-}" ;;
  *) usage; exit 2 ;;
esac
