#!/usr/bin/env bash

set -euo pipefail

ROUTER="${1:-root@192.168.8.1}"
EXPECTED_OLD_IP="${2:?expected old ingest IPv4 is required}"
NEW_IP="${3:?new ingest IPv4 is required}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
REMOTE_TMP="/tmp/scorecheck-anchor-rebind-$STAMP"
REMOTE_BACKUP="/root/scorecheck-anchor-rebind-backup-$STAMP"
SSH_OPTIONS=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes)
ROUTING_SHA="$(shasum -a 256 "$SCRIPT_DIR/scorecheck-speedify-routing.sh" | awk '{print $1}')"
RECORDER_SHA="$(shasum -a 256 "$SCRIPT_DIR/scorecheck-speedify-soak-recorder.sh" | awk '{print $1}')"

is_ipv4() {
  local value="$1"
  local octet
  IFS=. read -r -a octets <<<"$value"
  [[ "${#octets[@]}" -eq 4 ]] || return 1
  for octet in "${octets[@]}"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] && ((octet >= 0 && octet <= 255)) || return 1
  done
}

is_ipv4 "$EXPECTED_OLD_IP" || {
  printf 'Expected old ingest endpoint is not an IPv4 address.\n' >&2
  exit 2
}
is_ipv4 "$NEW_IP" || {
  printf 'New ingest endpoint is not an IPv4 address.\n' >&2
  exit 2
}
[[ "$EXPECTED_OLD_IP" != "$NEW_IP" ]] || {
  printf 'Old and new ingest endpoints must differ.\n' >&2
  exit 2
}

ssh "${SSH_OPTIONS[@]}" "$ROUTER" "umask 077; mkdir -p '$REMOTE_TMP'; chmod 0700 '$REMOTE_TMP'"
scp -q -O "${SSH_OPTIONS[@]}" \
  "$SCRIPT_DIR/scorecheck-speedify-routing.sh" \
  "$SCRIPT_DIR/scorecheck-speedify-soak-recorder.sh" \
  "$ROUTER:$REMOTE_TMP/"

set +e
ssh "${SSH_OPTIONS[@]}" "$ROUTER" \
  "OLD_IP='$EXPECTED_OLD_IP' NEW_IP='$NEW_IP' REMOTE_TMP='$REMOTE_TMP' BACKUP='$REMOTE_BACKUP' ROUTING_SHA='$ROUTING_SHA' RECORDER_SHA='$RECORDER_SHA' sh -s" <<'REMOTE'
set -eu

rollback_needed=1
stage="preflight"
rollback() {
  code="$?"
  trap - EXIT HUP INT TERM
  printf 'ROUTER_CUTOVER_FAILED stage=%s code=%s\n' "$stage" "$code" >&2
  if [ "$rollback_needed" -eq 1 ] && [ -d "$BACKUP" ]; then
    cp "$BACKUP/network" /etc/config/network
    cp "$BACKUP/scorecheck-speedify-routing" /usr/sbin/scorecheck-speedify-routing
    cp "$BACKUP/scorecheck-speedify-soak-recorder" /usr/sbin/scorecheck-speedify-soak-recorder
    cp "$BACKUP/scorecheck-speedify.enabled" /etc/scorecheck-speedify.enabled
    chmod 0755 /usr/sbin/scorecheck-speedify-routing /usr/sbin/scorecheck-speedify-soak-recorder
    chmod 0600 /etc/scorecheck-speedify.enabled
    ifdown camera_lan >/dev/null 2>&1 || true
    ifup camera_lan >/dev/null 2>&1 || true
    /etc/init.d/scorecheck-speedify-watchdog restart >/dev/null 2>&1 || true
  fi
  rm -rf "$REMOTE_TMP"
  exit "$code"
}
trap rollback EXIT HUP INT TERM

stage="preflight-endpoint"
[ "$(uci -q get network.camera_lan_peer.endpoint_host)" = "$OLD_IP" ]
stage="preflight-old-flows"
[ "$(conntrack -L -d "$OLD_IP" 2>/dev/null | grep -Ec 'dport=(1935|8890)' || true)" -eq 0 ]
stage="preflight-new-flows"
[ "$(conntrack -L -d "$NEW_IP" 2>/dev/null | grep -Ec 'dport=(1935|8890)' || true)" -eq 0 ]
stage="preflight-routing-source"
grep -Fq 'INGEST_IP="${SCORECHECK_INGEST_IP:-'"$NEW_IP"'}"' "$REMOTE_TMP/scorecheck-speedify-routing.sh"
stage="preflight-recorder-source"
grep -Fq 'INGEST_IP="${SCORECHECK_INGEST_IP:-'"$NEW_IP"'}"' "$REMOTE_TMP/scorecheck-speedify-soak-recorder.sh"

stage="backup"
mkdir -p "$BACKUP"
chmod 0700 "$BACKUP"
cp /etc/config/network "$BACKUP/network"
cp /usr/sbin/scorecheck-speedify-routing "$BACKUP/scorecheck-speedify-routing"
cp /usr/sbin/scorecheck-speedify-soak-recorder "$BACKUP/scorecheck-speedify-soak-recorder"
cp /etc/scorecheck-speedify.enabled "$BACKUP/scorecheck-speedify.enabled"
chmod 0600 "$BACKUP"/*

stage="configuration"
uci set network.camera_lan_peer.endpoint_host="$NEW_IP"
uci commit network
cp "$REMOTE_TMP/scorecheck-speedify-routing.sh" /usr/sbin/scorecheck-speedify-routing
cp "$REMOTE_TMP/scorecheck-speedify-soak-recorder.sh" /usr/sbin/scorecheck-speedify-soak-recorder
chmod 0755 /usr/sbin/scorecheck-speedify-routing /usr/sbin/scorecheck-speedify-soak-recorder

enabled_tmp="/etc/scorecheck-speedify.enabled.anchor.$$"
awk -v ip="$NEW_IP" '
  /^ingest_ip=/ { print "ingest_ip=" ip; found=1; next }
  { print }
  END { if (!found) print "ingest_ip=" ip }
' /etc/scorecheck-speedify.enabled >"$enabled_tmp"
chmod 0600 "$enabled_tmp"
mv "$enabled_tmp" /etc/scorecheck-speedify.enabled

stage="services"
ifdown camera_lan >/dev/null 2>&1 || true
sleep 1
ifup camera_lan >/dev/null 2>&1
/etc/init.d/scorecheck-speedify-watchdog restart
sleep 4
stage="reconcile"
/usr/sbin/scorecheck-speedify-routing reconcile-once

stage="postconditions"
[ "$(uci -q get network.camera_lan_peer.endpoint_host)" = "$NEW_IP" ]
[ "$(grep -c "^ingest_ip=$NEW_IP$" /etc/scorecheck-speedify.enabled)" -eq 1 ]
[ "$(sha256sum /usr/sbin/scorecheck-speedify-routing | awk '{print $1}')" = "$ROUTING_SHA" ]
[ "$(sha256sum /usr/sbin/scorecheck-speedify-soak-recorder | awk '{print $1}')" = "$RECORDER_SHA" ]
[ "$(ip rule show | grep -c "$NEW_IP" || true)" -eq 4 ]
[ "$(ip rule show | grep -c "$OLD_IP" || true)" -eq 0 ]
[ "$(iptables-save | grep -c -- "-d $NEW_IP/32" || true)" -eq 2 ]
[ "$(iptables-save | grep -c -- "-d $OLD_IP/32" || true)" -eq 0 ]
ip route get "$NEW_IP" ipproto udp dport 8890 | grep -Fq 'dev connectify0 table 900'
ip route get "$NEW_IP" ipproto tcp dport 1935 | grep -Fq 'dev connectify0 table 900'
/usr/sbin/scorecheck-speedify-routing status | grep -Fxq 'Speedify state: CONNECTED'
/usr/sbin/scorecheck-speedify-routing status | grep -Fxq 'Runtime status: CONNECTED_ROUTED'
/usr/sbin/scorecheck-speedify-routing status | grep -Fxq 'Firewall kill switch: active'

watchdog_owner="$(cat /var/run/scorecheck-speedify-watch.pid)"
kill -0 "$watchdog_owner"
watchdog_count=0
for cmdline in /proc/[0-9]*/cmdline; do
  command="$(tr '\000' ' ' <"$cmdline" 2>/dev/null || true)"
  case "$command" in
    '/bin/sh /usr/sbin/scorecheck-speedify-routing watch '|'sh /usr/sbin/scorecheck-speedify-routing watch ')
      watchdog_count=$((watchdog_count + 1))
      ;;
  esac
done
[ "$watchdog_count" -eq 1 ]

handshake_ready=0
attempt=0
while [ "$attempt" -lt 45 ]; do
  latest_handshake="$(wg show camera_lan latest-handshakes 2>/dev/null | awk '{if ($2>latest) latest=$2} END {print latest+0}')"
  now="$(date +%s)"
  handshake_age=$((now - latest_handshake))
  if [ "$latest_handshake" -gt 0 ] && [ "$handshake_age" -ge 0 ] && [ "$handshake_age" -le 180 ]; then
    handshake_ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$handshake_ready" -eq 1 ]

rollback_needed=0
rm -rf "$REMOTE_TMP"
trap - EXIT HUP INT TERM
printf 'ROUTER_CUTOVER_APPLIED\n'
printf 'REMOTE_BACKUP=%s\n' "$BACKUP"
printf 'HANDSHAKE_AGE_SECONDS=%s\n' "$handshake_age"
printf 'WATCHDOG_COUNT=%s\n' "$watchdog_count"
REMOTE
status=$?
set -e

if [[ "$status" -ne 0 ]]; then
  printf 'Router cutover failed and restored its pre-cutover files.\n' >&2
  exit "$status"
fi

ssh "${SSH_OPTIONS[@]}" "$ROUTER" '
  printf "ROUTER_STATUS\n"
  /usr/sbin/scorecheck-speedify-routing status
  printf "WIREGUARD_ENDPOINT\n"
  wg show camera_lan endpoints 2>/dev/null | awk "{print \$2}"
  printf "SCRIPT_HASHES\n"
  sha256sum /usr/sbin/scorecheck-speedify-routing /usr/sbin/scorecheck-speedify-soak-recorder
'
