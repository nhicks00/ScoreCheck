#!/usr/bin/env bash

set -euo pipefail
umask 077

FROM_PRIVATE_IP="${1:?usage: rebind-ingest.sh <from-private-ip> <to-private-ip> <ingest-host>}"
TO_PRIVATE_IP="${2:?usage: rebind-ingest.sh <from-private-ip> <to-private-ip> <ingest-host>}"
INGEST_HOST="${3:?usage: rebind-ingest.sh <from-private-ip> <to-private-ip> <ingest-host>}"
COMPOSITOR_DIR="${COMPOSITOR_DIR:-/opt/compositor}"

for address in "$FROM_PRIVATE_IP" "$TO_PRIVATE_IP"; do
  [[ "$address" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9.]+$ ]] || {
    echo "error: compositor ingest binding must use private IPv4 addresses" >&2
    exit 1
  }
done
[[ "$FROM_PRIVATE_IP" != "$TO_PRIVATE_IP" ]] || { echo "error: compositor ingest binding requires distinct addresses" >&2; exit 1; }
[[ "$INGEST_HOST" =~ ^[a-z0-9.-]+$ && "$INGEST_HOST" == *.* ]] || { echo "error: ingest host is invalid" >&2; exit 1; }

cd "$COMPOSITOR_DIR"
[[ -f .env && -f docker-compose.yml ]] || { echo "error: compositor deployment is incomplete" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "error: flock is required" >&2; exit 1; }
exec 9>rebind-ingest.lock
flock -n 9 || { echo "error: another compositor ingest rebind is active" >&2; exit 1; }

private_lines="$(grep -c '^MEDIAMTX_PRIVATE_HOST=' .env || true)"
public_lines="$(grep -c '^MEDIAMTX_PUBLIC_HOST=' .env || true)"
[[ "$private_lines" == "1" && "$public_lines" == "1" ]] || { echo "error: compositor ingest binding is ambiguous" >&2; exit 1; }
current="$(sed -n 's/^MEDIAMTX_PRIVATE_HOST="\{0,1\}\([^"[:space:]]*\)"\{0,1\}$/\1/p' .env)"
public="$(sed -n 's/^MEDIAMTX_PUBLIC_HOST="\{0,1\}\([^"[:space:]]*\)"\{0,1\}$/\1/p' .env)"
[[ "$public" == "$INGEST_HOST" ]] || { echo "error: compositor public ingest hostname drifted" >&2; exit 1; }
[[ "$current" == "$FROM_PRIVATE_IP" || "$current" == "$TO_PRIVATE_IP" ]] || { echo "error: compositor private ingest binding drifted" >&2; exit 1; }

verify_target() {
  docker compose config -q \
    && [[ "$(docker inspect bvm-egress --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" == "healthy" ]] \
    && docker inspect bvm-egress --format '{{json .HostConfig.ExtraHosts}}' | grep -Fq "$INGEST_HOST:$TO_PRIVATE_IP"
}

if [[ "$current" == "$TO_PRIVATE_IP" ]]; then
  verify_target || { echo "error: converged compositor binding is not healthy" >&2; exit 1; }
  echo "Compositor ingest binding already converged."
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="backups/rebind-ingest-$timestamp.env"
mkdir -p backups
cp .env "$backup"
temporary=".env.rebind.$$"
awk '!/^MEDIAMTX_PRIVATE_HOST=/' .env >"$temporary"
printf 'MEDIAMTX_PRIVATE_HOST="%s"\n' "$TO_PRIVATE_IP" >>"$temporary"
chmod 600 "$temporary"

systemctl stop compositor.service
docker compose down --remove-orphans
mv "$temporary" .env
if systemctl start compositor.service; then
  for _ in $(seq 1 120); do
    if verify_target; then
      echo "Compositor ingest binding updated and healthy."
      exit 0
    fi
    sleep 1
  done
fi

systemctl stop compositor.service >/dev/null 2>&1 || true
docker compose down --remove-orphans >/dev/null 2>&1 || true
cp "$backup" .env
systemctl start compositor.service >/dev/null 2>&1 || true
echo "error: compositor ingest rebind failed; previous binding restored" >&2
exit 1
