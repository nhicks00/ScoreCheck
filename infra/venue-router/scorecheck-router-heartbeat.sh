#!/bin/sh

set -eu

MONITOR_URL="${SCORECHECK_ROUTER_MONITOR_URL:-https://monitor.beachvolleyballmedia.com/v1/router-heartbeats}"
TOKEN_FILE="${SCORECHECK_ROUTER_MONITOR_TOKEN_FILE:-/etc/scorecheck-monitoring-router-token}"
INTERVAL_SECONDS="${SCORECHECK_ROUTER_MONITOR_INTERVAL_SECONDS:-10}"
INGEST_IP="${SCORECHECK_INGEST_IP:-138.197.236.201}"
PRIMARY_TABLE="${SCORECHECK_SPEEDIFY_ROUTE_TABLE:-900}"
GUARD_TABLE="${SCORECHECK_SPEEDIFY_GUARD_TABLE:-901}"
FIREWALL_CHAIN="${SCORECHECK_SPEEDIFY_FIREWALL_CHAIN:-SCORECHECK_CAMERA_EGRESS}"
MODE="${1:-run}"

case "$INTERVAL_SECONDS" in
  ''|*[!0-9]*) echo "heartbeat interval must be an integer" >&2; exit 64 ;;
esac
[ "$INTERVAL_SECONDS" -ge 5 ] && [ "$INTERVAL_SECONDS" -le 60 ] \
  || { echo "heartbeat interval must be between 5 and 60 seconds" >&2; exit 64; }
case "$MODE" in run|print-once) ;; *) echo "usage: $0 [print-once]" >&2; exit 64 ;; esac
[ "$MODE" = print-once ] || [ -r "$TOKEN_FILE" ] \
  || { echo "router heartbeat token file is unavailable" >&2; exit 78; }

SESSION_ID="$(cat /proc/sys/kernel/random/uuid)"
SEQUENCE=0
LAST_STATUS=""

json_value() {
  value="$(jsonfilter -s "$1" -e "$2" 2>/dev/null | sed -n '1p' || true)"
  [ -n "$value" ] && printf '%s' "$value" || printf '%s' "${3:-null}"
}

json_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\r/\\r/g; s/\t/\\t/g'
}

bool_value() {
  case "$1" in true|1|on|yes) printf true ;; *) printf false ;; esac
}

route_dev() {
  protocol="$1"
  port="$2"
  device="$(ip route get "$INGEST_IP" ipproto "$protocol" dport "$port" 2>/dev/null \
    | sed -n '1s/.* dev \([^ ]*\).*/\1/p' || true)"
  [ -n "$device" ] && printf '%s' "$device" || printf blocked
}

rule_count() {
  ip rule show | awk -v table="$1" '$0 ~ ("lookup " table "$") {count++} END {print count + 0}'
}

kill_switch_active() {
  iptables -C forwarding_rule -j "$FIREWALL_CHAIN" >/dev/null 2>&1 \
    && [ "$(iptables -S "$FIREWALL_CHAIN" 2>/dev/null | grep -c "^-A $FIREWALL_CHAIN " || true)" -eq 3 ]
}

speedify_rss_bytes() {
  pid="$(pidof speedify 2>/dev/null | awk '{print $1}')"
  if [ -n "$pid" ] && [ -r "/proc/$pid/status" ]; then
    awk '$1 == "VmRSS:" {print $2 * 1024; found=1} END {if (!found) print 0}' "/proc/$pid/status"
  else
    printf 0
  fi
}

streaming_stats_process_count() {
  ps w 2>/dev/null | grep 'speedify_cli -s [s]tats' | wc -l | tr -d ' '
}

uplink_type() {
  case "$1:$2" in
    rmnet*:*|*:*Cellular*) printf cellular ;;
    apcli*:*|*:*WiFi*|*:*Wi-Fi*|*:*Wireless*) printf wifi ;;
    *:*Ethernet*) printf ethernet ;;
    *) printf other ;;
  esac
}

working_priority_value() {
  case "$1" in always|secondary|backup|never) printf '%s' "$1" ;; *) printf unknown ;; esac
}

saved_priority_value() {
  case "$1" in automatic|always|secondary|backup|never) printf '%s' "$1" ;; *) printf unknown ;; esac
}

physical_connection() {
  stats_line="$1"
  adapter_id="$2"
  jsonfilter -s "$stats_line" -e "@[1].connections[@.adapterID=\"$adapter_id\"]" 2>/dev/null \
    | while IFS= read -r connection; do
        protocol="$(json_value "$connection" '@.protocol' 'unknown')"
        case "$protocol" in
          udp|tcp|tcp-multi|https)
            printf '%s\n' "$connection"
            break
            ;;
        esac
      done
}

build_uplinks() {
  stats_line="$1"
  adapters="$2"
  first=1
  printf '['
  for id in $(jsonfilter -s "$adapters" -e '@[*].adapterID' 2>/dev/null || true); do
    adapter="$(jsonfilter -s "$adapters" -e "@[@.adapterID=\"$id\"]" 2>/dev/null | sed -n '1p' || true)"
    [ -n "$adapter" ] || continue
    connection="$(physical_connection "$stats_line" "$id" | sed -n '1p' || true)"
    [ "$first" -eq 1 ] || printf ','
    first=0
    isp="$(json_value "$adapter" '@.isp' '')"
    type="$(uplink_type "$id" "$(json_value "$adapter" '@.type' '')")"
    priority="$(working_priority_value "$(json_value "$adapter" '@.workingPriority' 'unknown')")"
    saved_priority="$(saved_priority_value "$(json_value "$adapter" '@.priority' 'unknown')")"
    connected="$(bool_value "$(json_value "$connection" '@.connected' 'false')")"
    estimated_mbps="$(json_value "$connection" '@.sendEstimateMbps' 'null')"
    if [ "$estimated_mbps" = null ]; then estimated_bps=null; else estimated_bps="$(awk -v value="$estimated_mbps" 'BEGIN {printf "%.0f", value * 1000000}')"; fi
    printf '{"id":"%s","isp":%s,"type":"%s","connected":%s,"priority":"%s","savedPriority":"%s","sendBps":%s,"receiveBps":%s,"estimatedUploadBps":%s,"latencyMs":%s,"jitterMs":%s,"lossSendRatio":%s,"lossReceiveRatio":%s,"inFlightBytes":%s,"inFlightWindowBytes":%s,"uploadCongested":%s,"poorConnection":%s,"slowConnection":%s}' \
      "$(json_string "$id")" \
      "$([ -n "$isp" ] && printf '"%s"' "$(json_string "$isp")" || printf null)" \
      "$type" "$connected" "$priority" "$saved_priority" \
      "$(json_value "$connection" '@.sendBps' '0')" \
      "$(json_value "$connection" '@.receiveBps' '0')" \
      "$estimated_bps" \
      "$(json_value "$connection" '@.latencyMs' 'null')" \
      "$(json_value "$connection" '@.jitterMs' 'null')" \
      "$(json_value "$connection" '@.lossSend' 'null')" \
      "$(json_value "$connection" '@.lossReceive' 'null')" \
      "$(json_value "$connection" '@.inFlight' 'null')" \
      "$(json_value "$connection" '@.inFlightWindow' 'null')" \
      "$(bool_value "$(json_value "$connection" '@.uploadCongested' 'false')")" \
      "$(bool_value "$(json_value "$connection" '@.poorConnection' 'false')")" \
      "$(bool_value "$(json_value "$connection" '@.slowConnection' 'false')")"
  done
  printf ']'
}

send_heartbeat() {
  SEQUENCE=$((SEQUENCE + 1))
  current_stats="$(timeout 3 speedify_cli -s stats 1 current 2>/dev/null || true)"
  connection_stats="$(printf '%s\n' "$current_stats" | sed -n '/^\["connection_stats",/p' | tail -n 1)"
  [ -n "$connection_stats" ] || return 1
  session_stats="$(speedify_cli -s stats session current 2>/dev/null || printf '{}')"
  streaming_stats="$(speedify_cli -s stats streaming 2>/dev/null || printf '{}')"
  settings="$(speedify_cli -s show settings 2>/dev/null || printf '{}')"
  adapters="$(speedify_cli -s show adapters 2>/dev/null || printf '[]')"
  version_info="$(speedify_cli version 2>/dev/null || printf '{}')"
  speedify_connection="$(jsonfilter -s "$connection_stats" -e '@[1].connections[@.protocol="auto"]' 2>/dev/null | sed -n '1p' || true)"
  [ -n "$speedify_connection" ] || return 1

  state="$(speedify_cli -s state 2>/dev/null | sed -n 's/.*"state":"\([^"]*\)".*/\1/p' || true)"
  case "$state" in CONNECTED|LOGGED_IN|DISCONNECTED) ;; *) state=UNKNOWN ;; esac
  bonding="$(json_value "$settings" '@.bondingMode' 'unknown')"
  case "$bonding" in speed|streaming|redundant) ;; *) bonding=unknown ;; esac
  transport="$(json_value "$settings" '@.transportMode' 'unknown')"
  case "$transport" in udp|tcp|tcp-multi|https|auto) ;; *) transport=unknown ;; esac

  estimated_upload_bps=0
  has_estimate=0
  for adapter_id in $(jsonfilter -s "$adapters" -e '@[*].adapterID' 2>/dev/null || true); do
    connection="$(physical_connection "$connection_stats" "$adapter_id" | sed -n '1p' || true)"
    value="$(json_value "$connection" '@.sendEstimateMbps' 'null')"
    [ "$value" != null ] || continue
    estimated_upload_bps="$(awk -v total="$estimated_upload_bps" -v item="$value" 'BEGIN {printf "%.0f", total + item * 1000000}')"
    has_estimate=1
  done
  [ "$has_estimate" -eq 1 ] || estimated_upload_bps=null

  adapter_count="$(jsonfilter -s "$adapters" -e '@[*].adapterID' 2>/dev/null | wc -l | tr -d ' ')"
  automatic_adapter_count="$(jsonfilter -s "$adapters" -e '@[*].priority' 2>/dev/null \
    | awk '$0 == "automatic" {count++} END {print count + 0}')"
  version_major="$(json_value "$version_info" '@.maj' 'unknown')"
  version_minor="$(json_value "$version_info" '@.min' 'unknown')"
  version_bug="$(json_value "$version_info" '@.bug' 'unknown')"
  version_build="$(json_value "$version_info" '@.build' 'unknown')"
  software_version="${version_major}.${version_minor}.${version_bug}-${version_build}"

  uplinks="$(build_uplinks "$connection_stats" "$adapters")"
  kill_switch=false
  kill_switch_active && kill_switch=true
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  mem_available_bytes="$(awk '$1 == "MemAvailable:" {print $2 * 1024}' /proc/meminfo)"
  [ -n "$mem_available_bytes" ] || mem_available_bytes=0
  failover_count="$(json_value "$session_stats" '@.current.numFailovers' 'null')"
  read_queue="$(json_value "$session_stats" '@.current.tun.readQueue' 'null')"

  body="$(printf '{"version":2,"sessionId":"%s","sequence":%s,"sampledAt":"%s","speedify":{"state":"%s","softwareVersion":"%s","bondingMode":"%s","transportMode":"%s","adapterCount":%s,"automaticAdapterCount":%s,"sendBps":%s,"receiveBps":%s,"estimatedUploadBps":%s,"latencyMs":%s,"jitterMs":%s,"lossSendRatio":%s,"lossReceiveRatio":%s,"uploadCongested":%s,"badCpu":%s,"badLatency":%s,"badLoss":%s,"badMemory":%s,"readQueuePackets":%s,"failoverCount":%s},"routing":{"srtDevice":"%s","rtmpDevice":"%s","primaryRuleCount":%s,"guardRuleCount":%s,"killSwitchActive":%s,"cameraFlowCount":%s},"host":{"load1":%s,"memoryAvailableBytes":%s,"speedifyRssBytes":%s,"streamingStatsProcessCount":%s},"uplinks":%s}' \
    "$SESSION_ID" "$SEQUENCE" "$now" "$state" "$software_version" "$bonding" "$transport" \
    "$adapter_count" "$automatic_adapter_count" \
    "$(json_value "$speedify_connection" '@.sendBps' '0')" \
    "$(json_value "$speedify_connection" '@.receiveBps' '0')" \
    "$estimated_upload_bps" \
    "$(json_value "$speedify_connection" '@.latencyMs' 'null')" \
    "$(json_value "$speedify_connection" '@.jitterMs' 'null')" \
    "$(json_value "$speedify_connection" '@.lossSend' 'null')" \
    "$(json_value "$speedify_connection" '@.lossReceive' 'null')" \
    "$(bool_value "$(json_value "$speedify_connection" '@.uploadCongested' 'false')")" \
    "$(bool_value "$(json_value "$streaming_stats" '@.badCpu' 'false')")" \
    "$(bool_value "$(json_value "$streaming_stats" '@.badLatency' 'false')")" \
    "$(bool_value "$(json_value "$streaming_stats" '@.badLoss' 'false')")" \
    "$(bool_value "$(json_value "$streaming_stats" '@.badMemory' 'false')")" \
    "$read_queue" "$failover_count" \
    "$(route_dev udp 8890)" "$(route_dev tcp 1935)" \
    "$(rule_count "$PRIMARY_TABLE")" "$(rule_count "$GUARD_TABLE")" "$kill_switch" \
    "$(conntrack -L -d "$INGEST_IP" 2>/dev/null | grep -Ec 'dport=(1935|8890)' || true)" \
    "$(awk '{print $1}' /proc/loadavg)" "$mem_available_bytes" "$(speedify_rss_bytes)" \
    "$(streaming_stats_process_count)" "$uplinks")"

  if [ "$MODE" = print-once ]; then
    printf '%s\n' "$body"
    return 0
  fi
  auth_header="Authorization: Bearer $(cat "$TOKEN_FILE")"
  curl -fsS --connect-timeout 4 --max-time 8 \
    -H @/proc/self/fd/3 \
    -H 'Content-Type: application/json' \
    --data-binary "$body" "$MONITOR_URL" >/dev/null 3<<EOF
$auth_header
EOF
  unset auth_header
}

if [ "$MODE" = print-once ]; then
  send_heartbeat
  exit
fi

while :; do
  if send_heartbeat; then status=healthy; else status=failed; fi
  if [ "$status" != "$LAST_STATUS" ]; then
    logger -t scorecheck-router-heartbeat "monitor heartbeat $status" 2>/dev/null || true
    LAST_STATUS="$status"
  fi
  sleep "$INTERVAL_SECONDS"
done
