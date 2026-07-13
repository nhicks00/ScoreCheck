#!/bin/sh

set -eu

INGEST_IP="${SCORECHECK_INGEST_IP:-206.189.169.162}"
ROUTE_TABLE="${SCORECHECK_SPEEDIFY_ROUTE_TABLE:-900}"
# These must run before Speedify's router safety rules, which begin at 800.
SRT_RULE_PREF="${SCORECHECK_SPEEDIFY_SRT_RULE_PREF:-700}"
RTMP_RULE_PREF="${SCORECHECK_SPEEDIFY_RTMP_RULE_PREF:-701}"
MIN_UPLOAD_MBPS="${SCORECHECK_MIN_BONDED_UPLOAD_MBPS:-75}"
STATE_FILE="${SCORECHECK_SPEEDIFY_STATE_FILE:-/var/run/scorecheck-speedify-routing}"
ROLLBACK_NEEDED=0

usage() {
  cat <<EOF
Usage: $0 preflight VALIDATED_UPLOAD_MBPS
       $0 apply VALIDATED_UPLOAD_MBPS
       $0 reset
       $0 status

Apply this before camera publishers start. The measured bonded upload must be
at least ${MIN_UPLOAD_MBPS} Mbps. Ordinary LAN traffic remains outside Speedify.
EOF
}

log() {
  printf '%s\n' "scorecheck-speedify: $*"
}

die() {
  printf '%s\n' "scorecheck-speedify: error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is missing: $1"
}

validate_capacity() {
  capacity="${1:-}"
  case "$capacity" in
    ''|*[!0-9]*) die "validated upload must be an integer Mbps value" ;;
  esac
  [ "$capacity" -ge "$MIN_UPLOAD_MBPS" ] || die \
    "validated bonded upload is ${capacity} Mbps; at least ${MIN_UPLOAD_MBPS} Mbps is required"
}

active_camera_flows() {
  conntrack -L -d "$INGEST_IP" 2>/dev/null | grep -Eq 'dport=(1935|8890)'
}

rule_for_pref() {
  pref="$1"
  ip rule show | awk -v target="${pref}:" '$1 == target'
}

assert_rule_slot_available() {
  pref="$1"
  existing="$(rule_for_pref "$pref")"
  if [ -n "$existing" ] && ! printf '%s\n' "$existing" | grep -q "lookup $ROUTE_TABLE"; then
    die "policy priority $pref is already owned by another route table"
  fi
}

remove_rule() {
  pref="$1"
  existing="$(rule_for_pref "$pref")"
  if [ -n "$existing" ] && ! printf '%s\n' "$existing" | grep -q "lookup $ROUTE_TABLE"; then
    log "left unrelated policy priority $pref unchanged"
    return 0
  fi
  while ip rule show | grep -q "^${pref}:"; do
    ip rule del pref "$pref" 2>/dev/null || break
  done
}

remove_legacy_host_route() {
  if command -v uci >/dev/null 2>&1 \
    && uci -q get network.camera_tunnel_via_speedify >/dev/null 2>&1; then
    uci -q delete network.camera_tunnel_via_speedify
    uci commit network
    log "removed the legacy ingest host route that bypassed Speedify"
  fi
  ip route del "$INGEST_IP/32" 2>/dev/null || true
}

wait_for_speedify() {
  attempts=0
  while [ "$attempts" -lt 20 ]; do
    if speedify_cli -s state 2>/dev/null | grep -q '"state":"CONNECTED"'; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  return 1
}

configure_speedify() {
  speedify_cli route default off >/dev/null
  speedify_cli mode speed >/dev/null
  speedify_cli transport udp >/dev/null
  speedify_cli targetconnections 0 0 >/dev/null
  speedify_cli pep on >/dev/null
}

install_routes() {
  tunnel_source="$(ip -4 -o addr show dev connectify0 | awk 'NR == 1 { split($4, value, "/"); print value[1] }')"
  [ -n "$tunnel_source" ] || die "connectify0 has no IPv4 address"

  ip route replace table "$ROUTE_TABLE" default dev connectify0 scope link src "$tunnel_source"
  remove_rule "$SRT_RULE_PREF"
  remove_rule "$RTMP_RULE_PREF"
  ip rule add pref "$SRT_RULE_PREF" to "$INGEST_IP/32" ipproto udp dport 8890 lookup "$ROUTE_TABLE"
  ip rule add pref "$RTMP_RULE_PREF" to "$INGEST_IP/32" ipproto tcp dport 1935 lookup "$ROUTE_TABLE"

  ip route get "$INGEST_IP" ipproto udp dport 8890 | grep -q "table $ROUTE_TABLE" \
    || die "SRT policy route did not resolve through table $ROUTE_TABLE"
  ip route get "$INGEST_IP" ipproto tcp dport 1935 | grep -q "table $ROUTE_TABLE" \
    || die "RTMP policy route did not resolve through table $ROUTE_TABLE"
}

reset_routes() {
  remove_rule "$SRT_RULE_PREF"
  remove_rule "$RTMP_RULE_PREF"
  ip route flush table "$ROUTE_TABLE" 2>/dev/null || true
  rm -f "$STATE_FILE"
}

rollback_apply() {
  result="$?"
  trap - 0 1 2 15
  if [ "$ROLLBACK_NEEDED" -eq 1 ]; then
    reset_routes
    speedify_cli disconnect >/dev/null 2>&1 || true
    log "incomplete apply rolled back"
  fi
  exit "$result"
}

fail_on_signal() {
  exit 1
}

preflight() {
  validate_capacity "${1:-}"
  require_command speedify_cli
  require_command conntrack
  require_command ip

  assert_rule_slot_available "$SRT_RULE_PREF"
  assert_rule_slot_available "$RTMP_RULE_PREF"
  active_camera_flows && die "camera publishers are active; prepare Speedify before starting cameras"
  state="$(speedify_cli -s state 2>/dev/null || true)"
  printf '%s' "$state" | grep -Eq '"state":"(LOGGED_IN|CONNECTED)"' \
    || die "Speedify is not logged in"
  log "preflight passed with ${1} Mbps validated bonded upload"
}

apply_routes() {
  capacity="${1:-}"
  preflight "$capacity"
  ROLLBACK_NEEDED=1
  trap rollback_apply 0
  trap fail_on_signal 1 2 15
  remove_legacy_host_route
  configure_speedify
  speedify_cli connect last >/dev/null
  wait_for_speedify || {
    speedify_cli disconnect >/dev/null 2>&1 || true
    die "Speedify did not reach CONNECTED"
  }
  [ -d /sys/class/net/connectify0 ] || die "Speedify connected without connectify0"

  install_routes

  {
    printf 'validated_upload_mbps=%s\n' "$capacity"
    printf 'ingest_ip=%s\n' "$INGEST_IP"
    printf 'configured_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$STATE_FILE"
  ROLLBACK_NEEDED=0
  trap - 0 1 2 15
  log "camera RTMP/SRT routes are active through Speedify; ordinary LAN traffic remains direct"
}

reset_all() {
  reset_routes
  conntrack -D -d "$INGEST_IP" >/dev/null 2>&1 || true
  speedify_cli disconnect >/dev/null 2>&1 || true
  log "selective routes removed and Speedify disconnected"
}

status() {
  echo "Speedify state: $(speedify_cli -s state 2>/dev/null || echo unavailable)"
  echo "Ingest IP: $INGEST_IP"
  echo "Policy rules:"
  ip rule show | grep -E "^(${SRT_RULE_PREF}|${RTMP_RULE_PREF}):" || echo "none"
  echo "Route table $ROUTE_TABLE:"
  ip route show table "$ROUTE_TABLE" 2>/dev/null || true
  if [ -f "$STATE_FILE" ]; then
    echo "Validated state:"
    cat "$STATE_FILE"
  fi
}

command="${1:-}"
case "$command" in
  preflight) preflight "${2:-}" ;;
  apply) apply_routes "${2:-}" ;;
  reset) reset_all ;;
  status) status ;;
  *) usage; exit 2 ;;
esac
