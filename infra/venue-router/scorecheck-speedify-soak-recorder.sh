#!/bin/sh

set -eu

INGEST_IP="${SCORECHECK_INGEST_IP:-206.189.169.162}"
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
  printf 'timestamp\tspeedify_state\tingest_route_dev\tpolicy_rule_count\tcamera_flow_count\tconnectify_rx_bytes\tconnectify_tx_bytes\teth0_rx_bytes\teth0_tx_bytes\trmnet_rx_bytes\trmnet_tx_bytes\twireguard_handshake_age_seconds\tload1\n' >"$LOG_FILE"
fi
chmod 0600 "$LOG_FILE"

started="$(date +%s)"
while :; do
  now="$(date +%s)"
  elapsed=$((now - started))
  [ "$elapsed" -le "$DURATION_SECONDS" ] || break

  state="$(speedify_cli -s state 2>/dev/null | sed -n 's/.*"state":"\([^"]*\)".*/\1/p')"
  [ -n "$state" ] || state="UNKNOWN"
  route_dev="$(ip route get "$INGEST_IP" 2>/dev/null | sed -n '1s/.* dev \([^ ]*\).*/\1/p')"
  [ -n "$route_dev" ] || route_dev="none"
  rule_count="$(ip rule show | awk '$1 ~ /^(700:|701:|702:|703:|704:)$/ {count++} END {print count + 0}')"
  flow_count="$(conntrack -L -d "$INGEST_IP" 2>/dev/null | grep -Ec 'dport=(1935|8890)' || true)"

  latest_handshake="$(wg show all latest-handshakes 2>/dev/null | awk '$2 > latest {latest=$2} END {print latest + 0}')"
  if [ "$latest_handshake" -gt 0 ]; then
    handshake_age=$((now - latest_handshake))
  else
    handshake_age=-1
  fi

  load1="$(awk '{print $1}' /proc/loadavg)"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    "$state" \
    "$route_dev" \
    "$rule_count" \
    "$flow_count" \
    "$(read_counter connectify0 rx_bytes)" \
    "$(read_counter connectify0 tx_bytes)" \
    "$(read_counter eth0 rx_bytes)" \
    "$(read_counter eth0 tx_bytes)" \
    "$(read_counter rmnet_mhi0 rx_bytes)" \
    "$(read_counter rmnet_mhi0 tx_bytes)" \
    "$handshake_age" \
    "$load1" >>"$LOG_FILE"

  sleep "$INTERVAL_SECONDS"
done

printf '# completed_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >>"$LOG_FILE"
