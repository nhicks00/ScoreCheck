#!/usr/bin/env bash

set -euo pipefail

SSH_HOST="${MEDIAMTX_SSH_HOST:?MEDIAMTX_SSH_HOST is required}"
SSH_KEY="${MEDIAMTX_SSH_KEY:-$HOME/.ssh/scorecheck_do}"
KNOWN_HOSTS="${SCORECHECK_SSH_KNOWN_HOSTS:?SCORECHECK_SSH_KNOWN_HOSTS is required}"
CONFIG="${MEDIAMTX_WIREGUARD_CONFIG:?MEDIAMTX_WIREGUARD_CONFIG is required}"

[[ -f "$CONFIG" ]] || { echo "error: WireGuard configuration is missing" >&2; exit 1; }
permissions="$(stat -f '%Lp' "$CONFIG" 2>/dev/null || stat -c '%a' "$CONFIG")"
(( (8#$permissions & 8#077) == 0 )) || { echo "error: WireGuard configuration must be mode 0600 or stricter" >&2; exit 1; }
grep -q '^\[Interface\]$' "$CONFIG" || { echo "error: WireGuard interface section is missing" >&2; exit 1; }
grep -q '^Address = 10\.89\.0\.1/24$' "$CONFIG" || { echo "error: WireGuard address contract is invalid" >&2; exit 1; }
grep -q '^ListenPort = 51820$' "$CONFIG" || { echo "error: WireGuard listen-port contract is invalid" >&2; exit 1; }
grep -q '^AllowedIPs = 10\.89\.0\.2/32, 192\.168\.8\.0/24$' "$CONFIG" || { echo "error: WireGuard route contract is invalid" >&2; exit 1; }

ssh_options=(-i "$SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$KNOWN_HOSTS")
rsync_shell="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS"

ssh "${ssh_options[@]}" "$SSH_HOST" "install -d -m 0700 /etc/wireguard /etc/wireguard/.incoming"
rsync -a -e "$rsync_shell" "$CONFIG" "$SSH_HOST:/etc/wireguard/.incoming/camera-lan.conf"

ssh "${ssh_options[@]}" "$SSH_HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup=""
if [[ -f /etc/wireguard/camera-lan.conf ]]; then
  backup="/etc/wireguard/camera-lan.conf.$timestamp"
  cp /etc/wireguard/camera-lan.conf "$backup"
fi
install -m 0600 /etc/wireguard/.incoming/camera-lan.conf /etc/wireguard/camera-lan.conf
rm -f /etc/wireguard/.incoming/camera-lan.conf
if ! systemctl enable --now wg-quick@camera-lan.service >/dev/null \
  || ! systemctl restart wg-quick@camera-lan.service \
  || ! ip link show camera-lan >/dev/null \
  || ! ip -4 address show dev camera-lan | grep -q '10\.89\.0\.1/24' \
  || ! ip route show 192.168.8.0/24 | grep -q 'dev camera-lan' \
  || ! wg show camera-lan >/dev/null; then
  systemctl stop wg-quick@camera-lan.service >/dev/null 2>&1 || true
  if [[ -n "$backup" && -f "$backup" ]]; then
    cp "$backup" /etc/wireguard/camera-lan.conf
    systemctl start wg-quick@camera-lan.service >/dev/null 2>&1 || true
  else
    rm -f /etc/wireguard/camera-lan.conf
    systemctl disable wg-quick@camera-lan.service >/dev/null 2>&1 || true
  fi
  echo "WireGuard deployment failed; previous configuration restored when available." >&2
  exit 1
fi
echo "MediaMTX private camera WireGuard route healthy."
REMOTE
