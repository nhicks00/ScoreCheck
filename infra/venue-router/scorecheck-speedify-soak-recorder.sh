#!/bin/sh

set -eu

INGEST_IP="${SCORECHECK_INGEST_IP:-138.197.236.201}"
SPEEDIFY_INTERFACE="${SCORECHECK_SPEEDIFY_INTERFACE:-connectify0}"
PRIMARY_TABLE="${SCORECHECK_SPEEDIFY_ROUTE_TABLE:-900}"
GUARD_TABLE="${SCORECHECK_SPEEDIFY_GUARD_TABLE:-901}"
FIREWALL_CHAIN="${SCORECHECK_SPEEDIFY_FIREWALL_CHAIN:-SCORECHECK_CAMERA_EGRESS}"
DURATION_SECONDS="${SCORECHECK_SOAK_DURATION_SECONDS:-36000}"
INTERVAL_SECONDS="${SCORECHECK_SOAK_INTERVAL_SECONDS:-60}"
LOG_FILE="${SCORECHECK_SOAK_LOG_FILE:-/root/scorecheck-speedify-soak.tsv}"
PID_FILE="${SCORECHECK_SOAK_PID_FILE:-/var/run/scorecheck-speedify-soak.pid}"

case "$DURATION_SECONDS:$INTERVAL_SECONDS" in
  *[!0-9:]*|:*|*:) echo "duration and interval must be positive integers" >&2; exit 64 ;;
esac
[ "$DURATION_SECONDS" -gt 0 ] && [ "$INTERVAL_SECONDS" -gt 0 ] \
  || { echo "duration and interval must be positive integers" >&2; exit 64; }

read_counter() {
  interface="$1"
  counter="$2"
  file="/sys/class/net/$interface/statistics/$counter"
  if [ -r "$file" ]; then cat "$file"; else printf '0'; fi
}

route_dev() {
  protocol="$1"
  port="$2"
  dev="$(ip route get "$INGEST_IP" ipproto "$protocol" dport "$port" 2>/dev/null \
    | sed -n '1s/.* dev \([^ ]*\).*/\1/p' || true)"
  [ -n "$dev" ] && printf '%s' "$dev" || printf 'blocked'
}

rule_count() {
  table="$1"
  ip rule show | awk -v table="$table" '$0 ~ ("lookup " table "$") {count++} END {print count + 0}'
}

kill_switch_state() {
  if iptables -C forwarding_rule -j "$FIREWALL_CHAIN" >/dev/null 2>&1 \
    && [ "$(iptables -S "$FIREWALL_CHAIN" 2>/dev/null | grep -c "^-A $FIREWALL_CHAIN " || true)" -eq 3 ]; then
    printf 'active'
  else
    printf 'inactive'
  fi
}

speedify_rss_kb() {
  pid="$(pidof speedify 2>/dev/null | awk '{print $1}')"
  if [ -n "$pid" ] && [ -r "/proc/$pid/status" ]; then
    awk '$1 == "VmRSS:" {print $2; found=1} END {if (!found) print 0}' "/proc/$pid/status"
  else
    printf '0'
  fi
}

streaming_stats_process_count() {
  # `speedify_cli -s stats` never terminates. Any instance is a leak and must
  # alarm; the recorder itself uses only the bounded one-shot state command.
  ps w 2>/dev/null | grep 'speedify_cli -s [s]tats' | wc -l | tr -d ' '
}

cleanup() {
  rm -f "$PID_FILE"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

umask 077
if [ -f "$PID_FILE" ]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "a soak recorder is already running with pid $existing_pid" >&2
    exit 1
  fi
fi
printf '%s\n' "$$" >"$PID_FILE"
chmod 0600 "$PID_FILE"

if [ ! -f "$LOG_FILE" ]; then
  printf 'timestamp\tspeedify_state\tsrt_route_dev\trtmp_route_dev\tprimary_rule_count\tguard_rule_count\tkill_switch\tcamera_flow_count\tconnectify_rx_bytes\tconnectify_tx_bytes\teth0_rx_bytes\teth0_tx_bytes\trmnet_rx_bytes\trmnet_tx_bytes\twireguard_handshake_age_seconds\tload1\tmem_available_kb\tspeedify_rss_kb\tstreaming_stats_process_count\n' >"$LOG_FILE"
fi
chmod 0600 "$LOG_FILE"

started="$(date +%s)"
while :; do
  now="$(date +%s)"
  elapsed=$((now - started))
  [ "$elapsed" -le "$DURATION_SECONDS" ] || break

  # This command is intentionally bounded. Do not use `speedify_cli -s stats`.
  state="$(speedify_cli -s state 2>/dev/null | sed -n 's/.*"state":"\([^"]*\)".*/\1/p' || true)"
  [ -n "$state" ] || state="UNKNOWN"
  flow_count="$(conntrack -L -d "$INGEST_IP" 2>/dev/null | grep -Ec 'dport=(1935|8890)' || true)"

  latest_handshake="$(wg show all latest-handshakes 2>/dev/null | awk '$2 > latest {latest=$2} END {print latest + 0}')"
  if [ "$latest_handshake" -gt 0 ]; then
    handshake_age=$((now - latest_handshake))
  else
    handshake_age=-1
  fi

  load1="$(awk '{print $1}' /proc/loadavg)"
  mem_available_kb="$(awk '$1 == "MemAvailable:" {print $2}' /proc/meminfo)"
  [ -n "$mem_available_kb" ] || mem_available_kb=0
  stats_processes="$(streaming_stats_process_count)"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    "$state" \
    "$(route_dev udp 8890)" \
    "$(route_dev tcp 1935)" \
    "$(rule_count "$PRIMARY_TABLE")" \
    "$(rule_count "$GUARD_TABLE")" \
    "$(kill_switch_state)" \
    "$flow_count" \
    "$(read_counter "$SPEEDIFY_INTERFACE" rx_bytes)" \
    "$(read_counter "$SPEEDIFY_INTERFACE" tx_bytes)" \
    "$(read_counter eth0 rx_bytes)" \
    "$(read_counter eth0 tx_bytes)" \
    "$(read_counter rmnet_mhi0 rx_bytes)" \
    "$(read_counter rmnet_mhi0 tx_bytes)" \
    "$handshake_age" \
    "$load1" \
    "$mem_available_kb" \
    "$(speedify_rss_kb)" \
    "$stats_processes" >>"$LOG_FILE"

  if [ "$stats_processes" -gt 0 ]; then
    logger -t scorecheck-speedify "ALERT: streaming speedify stats process detected" 2>/dev/null || true
  fi

  sleep "$INTERVAL_SECONDS"
done

printf '# completed_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$LOG_FILE"
