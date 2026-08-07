#!/bin/sh
set -eu

FRPS_IMAGE='docker.io/fatedier/frps@sha256:bb94aea95a79b65f7d45262342d0628ff885f78f5adebb6be4b90120b2657941'
REMOTE_DIR='/etc/scorecheck/venue-relay'
SERVICE='scorecheck-venue-relay.service'

usage() {
  printf 'Usage: %s --env ABSOLUTE_PATH --host SSH_HOST --private-ip IPV4\n' "$0" >&2
  exit 2
}

ENV_FILE=''
SSH_HOST=''
PRIVATE_IP=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE=${2-}; shift 2 ;;
    --host) SSH_HOST=${2-}; shift 2 ;;
    --private-ip) PRIVATE_IP=${2-}; shift 2 ;;
    *) usage ;;
  esac
done

case "$ENV_FILE" in /*) ;; *) usage ;; esac
[ -f "$ENV_FILE" ] || usage
[ "$(stat -f '%Lp' "$ENV_FILE")" = '600' ] || { printf 'Protected relay environment must be mode 0600.\n' >&2; exit 1; }
case "$SSH_HOST" in *[!A-Za-z0-9.-]*|'') usage ;; esac
printf '%s\n' "$PRIVATE_IP" | awk -F. '
  NF != 4 || $1 != 10 { exit 1 }
  { for (i = 1; i <= 4; i += 1) if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1 }
' || usage

# shellcheck disable=SC1090
. "$ENV_FILE"
: "${SCORECHECK_VENUE_RELAY_TOKEN:?SCORECHECK_VENUE_RELAY_TOKEN is required}"
[ "${#SCORECHECK_VENUE_RELAY_TOKEN}" -ge 32 ] || { printf 'Relay token must contain at least 32 characters.\n' >&2; exit 1; }

SSH_KEY=${SCORECHECK_UNIFI_SSH_KEY:-"$HOME/.ssh/scorecheck_do"}
KNOWN_HOSTS=${SCORECHECK_UNIFI_KNOWN_HOSTS:-"$HOME/.config/scorecheck/unifi/known_hosts"}
SSH_ALIAS=${SCORECHECK_UNIFI_SSH_ALIAS:-unifi.beachvolleyballmedia.com}

ssh_base="ssh -i $SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$KNOWN_HOSTS -o HostKeyAlias=$SSH_ALIAS root@$SSH_HOST"
token_encoded=$(printf '%s' "$SCORECHECK_VENUE_RELAY_TOKEN" | base64)

$ssh_base "set -eu
install -d -m 0700 '$REMOTE_DIR'
printf '%s' '$token_encoded' | base64 -d > '$REMOTE_DIR/token'
chmod 0600 '$REMOTE_DIR/token'
cat > '$REMOTE_DIR/frps.toml' <<EOF
bindAddr = \"0.0.0.0\"
bindPort = 7000
proxyBindAddr = \"$PRIVATE_IP\"
allowPorts = [{ single = 1161 }]
auth.method = \"token\"
auth.token = \"\$(cat '$REMOTE_DIR/token')\"
transport.tls.force = true
transport.maxPoolCount = 1
log.to = \"/dev/stdout\"
log.level = \"info\"
log.maxDays = 3
EOF
chmod 0600 '$REMOTE_DIR/frps.toml'
cat > '/etc/systemd/system/$SERVICE' <<EOF
[Unit]
Description=ScoreCheck venue SNMP relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=-/usr/bin/podman rm -f scorecheck-venue-relay
ExecStart=/usr/bin/podman run --rm --name scorecheck-venue-relay --network host --read-only --cap-drop all --security-opt no-new-privileges --memory 64m --cpus 0.10 -v '$REMOTE_DIR/frps.toml:/etc/frp/frps.toml:ro' '$FRPS_IMAGE' -c /etc/frp/frps.toml
ExecStop=/usr/bin/podman stop -t 10 scorecheck-venue-relay
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
podman pull '$FRPS_IMAGE'
ufw allow 7000/tcp comment 'ScoreCheck venue relay control'
ufw allow from 10.120.0.0/20 to '$PRIVATE_IP' port 1161 proto udp comment 'ScoreCheck private SNMP relay'
systemctl daemon-reload
systemctl enable --now '$SERVICE'
systemctl is-active --quiet '$SERVICE'
ss -ltn | grep -Fq ':7000 '
podman inspect scorecheck-venue-relay --format '{{.ImageName}} {{.State.Status}}'"

printf 'Venue relay server is active on %s; the SNMP listener appears only after the router client connects.\n' "$SSH_HOST"
