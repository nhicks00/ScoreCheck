#!/usr/bin/env bash

set -euo pipefail

ACTION="${1:?usage: recovery-role.sh <firewall-attach|firewall-detach|activate|deactivate|restore-compositor|status-staged|status-active> [vpc-cidr]}"
VPC_CIDR="${2:-10.120.0.0/20}"
RECOVERY_STATE_DIR="${RECOVERY_STATE_DIR:-/opt/mediamtx}"
FIREWALL_MARKER="$RECOVERY_STATE_DIR/.recovery-firewall-attached"

[[ "$VPC_CIDR" =~ ^10\.[0-9]{1,3}\.[0-9]{1,3}\.0/[0-9]{1,2}$ ]] || {
  echo "error: recovery VPC CIDR is invalid" >&2
  exit 1
}

public_rules=(80/tcp 443/tcp 1935/tcp 8189/udp 8890/udp 51820/udp)
private_rule="from $VPC_CIDR to any port 8554 proto tcp"

rule_present() {
  ufw show added | grep -Fx "ufw allow $1" >/dev/null
}

verify_ingest_firewall() {
  local rule
  for rule in "${public_rules[@]}"; do rule_present "$rule" || return 1; done
  rule_present "$private_rule"
}

verify_ingest_firewall_absent() {
  local rule
  for rule in "${public_rules[@]}"; do ! rule_present "$rule" || return 1; done
  ! rule_present "$private_rule"
}

write_firewall_marker() {
  install -d -m 0700 "$RECOVERY_STATE_DIR"
  printf '%s\n' "$VPC_CIDR" >"$FIREWALL_MARKER"
  chmod 0600 "$FIREWALL_MARKER"
}

verify_firewall_marker() {
  [[ -f "$FIREWALL_MARKER" && ! -L "$FIREWALL_MARKER" ]] \
    && [[ "$(cat "$FIREWALL_MARKER")" == "$VPC_CIDR" ]]
}

compose_health() {
  [[ "$(docker inspect mediamtx --format '{{.State.Running}}' 2>/dev/null || true)" == "true" ]] \
    && [[ "$(docker inspect bvm-mediamtx-caddy --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" == "healthy" ]] \
    && curl -fsS http://127.0.0.1:9997/v3/config/global/get >/dev/null
}

wireguard_health() {
  systemctl is-active --quiet wg-quick@camera-lan.service \
    && ip link show camera-lan >/dev/null \
    && ip -4 address show dev camera-lan | grep -q '10\.89\.0\.1/24' \
    && ip route show 192.168.8.0/24 | grep -q 'dev camera-lan' \
    && wg show camera-lan >/dev/null
}

case "$ACTION" in
  firewall-attach)
    if [[ -e "$FIREWALL_MARKER" ]]; then
      verify_firewall_marker || { echo "error: ingest firewall ownership marker is invalid" >&2; exit 1; }
    else
      verify_ingest_firewall_absent || { echo "error: refusing to adopt pre-existing ingest firewall rules" >&2; exit 1; }
      write_firewall_marker
    fi
    for rule in "${public_rules[@]}"; do ufw allow "$rule" >/dev/null; done
    ufw allow from "$VPC_CIDR" to any port 8554 proto tcp >/dev/null
    ufw --force enable >/dev/null
    verify_ingest_firewall || { echo "error: ingest firewall rules did not converge" >&2; exit 1; }
    echo "Ingest host firewall attached."
    ;;
  firewall-detach)
    if [[ ! -e "$FIREWALL_MARKER" ]]; then
      verify_ingest_firewall_absent || { echo "error: unowned ingest firewall rules remain" >&2; exit 1; }
      echo "Ingest host firewall already detached."
      exit 0
    fi
    verify_firewall_marker || { echo "error: ingest firewall ownership marker is invalid" >&2; exit 1; }
    for rule in "${public_rules[@]}"; do ufw --force delete allow "$rule" >/dev/null 2>&1 || true; done
    ufw --force delete allow from "$VPC_CIDR" to any port 8554 proto tcp >/dev/null 2>&1 || true
    verify_ingest_firewall_absent || { echo "error: ingest firewall rules remain after detach" >&2; exit 1; }
    rm -f "$FIREWALL_MARKER"
    echo "Ingest host firewall detached."
    ;;
  activate)
    verify_ingest_firewall || { echo "error: ingest firewall must be attached before activation" >&2; exit 1; }
    [[ -f /opt/mediamtx/docker-compose.yml && -f /opt/mediamtx/mediamtx.yml && -f /etc/wireguard/camera-lan.conf ]] || {
      echo "error: staged ingest role is incomplete" >&2
      exit 1
    }
    if [[ -f /opt/compositor/docker-compose.yml ]] && [[ "$(docker inspect bvm-egress --format '{{.State.Running}}' 2>/dev/null || true)" == "true" ]]; then
      cd /opt/compositor
      active="$(./list-egress.sh --active --json | jq -er 'if . == null then 0 elif type == "array" then length else error("invalid") end')"
      [[ "$active" == "0" ]] || { echo "error: spare compositor owns an active Egress" >&2; exit 1; }
    fi
    systemctl stop compositor.service >/dev/null 2>&1 || true
    if [[ -f /opt/compositor/docker-compose.yml ]]; then
      cd /opt/compositor
      docker compose down --remove-orphans
    fi
    systemctl enable --now wg-quick@camera-lan.service >/dev/null
    systemctl restart wg-quick@camera-lan.service
    cd /opt/mediamtx
    docker compose up -d --force-recreate
    for _ in $(seq 1 60); do
      if compose_health && wireguard_health; then
        echo "Spare ingest role active and locally healthy."
        exit 0
      fi
      sleep 1
    done
    echo "error: spare ingest role did not become healthy" >&2
    exit 1
    ;;
  deactivate)
    if [[ -f /opt/mediamtx/docker-compose.yml ]]; then
      cd /opt/mediamtx
      docker compose down --remove-orphans
    fi
    systemctl disable --now wg-quick@camera-lan.service >/dev/null 2>&1 || true
    ! ip link show camera-lan >/dev/null 2>&1 || { echo "error: camera-lan remains active" >&2; exit 1; }
    for container in mediamtx bvm-mediamtx-caddy; do
      [[ "$(docker inspect "$container" --format '{{.State.Running}}' 2>/dev/null || true)" != "true" ]] || {
        echo "error: ingest container $container remains active" >&2
        exit 1
      }
    done
    echo "Spare ingest role inactive."
    ;;
  restore-compositor)
    [[ ! -e "$FIREWALL_MARKER" ]] || { echo "error: ingest firewall ownership marker remains before compositor restoration" >&2; exit 1; }
    verify_ingest_firewall_absent || { echo "error: ingest firewall remains attached before compositor restoration" >&2; exit 1; }
    ! wireguard_health || { echo "error: WireGuard remains active before compositor restoration" >&2; exit 1; }
    ! compose_health || { echo "error: MediaMTX remains active before compositor restoration" >&2; exit 1; }
    systemctl start compositor.service
    for _ in $(seq 1 120); do
      redis_status="$(docker inspect bvm-redis --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
      egress_status="$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
      livekit_running="$(docker inspect bvm-livekit --format '{{.State.Running}}' 2>/dev/null || true)"
      if [[ "$redis_status" == "healthy" && "$egress_status" == "healthy" && "$livekit_running" == "true" ]] \
        && curl -fsS http://127.0.0.1:9090/metrics >/dev/null; then
        echo "Spare compositor role restored and healthy."
        exit 0
      fi
      sleep 1
    done
    echo "error: spare compositor role did not recover" >&2
    exit 1
    ;;
  status-staged)
    [[ -f /opt/mediamtx/docker-compose.yml && -f /opt/mediamtx/mediamtx.yml && -f /etc/wireguard/camera-lan.conf ]] \
      || { echo "error: staged ingest role is incomplete" >&2; exit 1; }
    ! wireguard_health || { echo "error: staged WireGuard is active" >&2; exit 1; }
    ! compose_health || { echo "error: staged MediaMTX is active" >&2; exit 1; }
    echo "Spare ingest role staged and stopped."
    ;;
  status-active)
    verify_firewall_marker && verify_ingest_firewall && compose_health && wireguard_health || {
      echo "error: spare ingest role is not healthy" >&2
      exit 1
    }
    echo "Spare ingest role active and locally healthy."
    ;;
  *)
    echo "error: unsupported recovery role action $ACTION" >&2
    exit 1
    ;;
esac
