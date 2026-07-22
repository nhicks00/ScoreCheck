#!/usr/bin/env bash

set -euo pipefail
umask 077

TARGET_FILE="${1:?usage: replace-agent-targets.sh <target-file> <prometheus-config>}"
PROMETHEUS_FILE="${2:?usage: replace-agent-targets.sh <target-file> <prometheus-config>}"
REMOTE_DIR="${MONITOR_REMOTE_DIR:-/opt/scorecheck-monitoring}"

for candidate in "$TARGET_FILE" "$PROMETHEUS_FILE"; do
  [[ -f "$candidate" && ! -L "$candidate" ]] || { echo "error: monitoring recovery input must be a regular file" >&2; exit 1; }
  permissions="$(stat -c '%a' "$candidate")"
  (( (8#$permissions & 8#077) == 0 )) || { echo "error: monitoring recovery input must be mode 0600 or stricter" >&2; exit 1; }
done
targets="$(cat "$TARGET_FILE")"
[[ -n "$targets" && "$targets" != *$'\n'* && "$targets" != *$'\r'* ]] || {
  echo "error: monitoring target payload is invalid" >&2
  exit 1
}
[[ "$targets" =~ ^[A-Za-z0-9._:/,+|=-]+$ ]] || { echo "error: monitoring target payload contains unsafe characters" >&2; exit 1; }

target_count="$(awk -F, '{print NF}' <<<"$targets")"
mediamtx_count="$(awk -F, '{count=0; for (i=1; i<=NF; i++) {split($i, fields, "\\|"); if (fields[2] == "mediamtx") count++} print count}' <<<"$targets")"
[[ "$target_count" == "11" || "$target_count" == "12" ]] || { echo "error: recovery monitoring requires 11 or 12 targets" >&2; exit 1; }
[[ "$mediamtx_count" == "1" ]] || { echo "error: recovery monitoring requires exactly one MediaMTX target" >&2; exit 1; }

cd "$REMOTE_DIR"
[[ -f .env && -f docker-compose.yml && -f .generated/prometheus.yml ]] || { echo "error: monitoring deployment is incomplete" >&2; exit 1; }
[[ "$(grep -c '^MONITOR_AGENT_TARGETS=' .env || true)" == "1" ]] || { echo "error: monitoring target environment is ambiguous" >&2; exit 1; }
current_line="$(grep '^MONITOR_AGENT_TARGETS=' .env)"
current="$(printf '%s' "${current_line#MONITOR_AGENT_TARGETS=}" | jq -erR fromjson)"
if [[ "$current" == "$targets" ]] \
  && cmp -s "$PROMETHEUS_FILE" .generated/prometheus.yml \
  && curl -fsS --max-time 5 http://127.0.0.1:9090/-/ready >/dev/null \
  && [[ "$(docker inspect scorecheck-monitor-service --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" == "healthy" ]]; then
  rm -f "$TARGET_FILE" "$PROMETHEUS_FILE"
  echo "Monitoring and Prometheus targets already converged."
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="backups/recovery-targets-$timestamp.env"
prometheus_backup="backups/recovery-prometheus-$timestamp.yml"
mkdir -p backups
cp .env "$backup"
cp .generated/prometheus.yml "$prometheus_backup"
prometheus_before="$(docker compose ps -q prometheus)"
[[ -n "$prometheus_before" && "$(docker inspect "$prometheus_before" --format '{{.State.Running}}' 2>/dev/null || true)" == "true" ]] \
  || { echo "error: Prometheus is not a running rollback baseline" >&2; exit 1; }
encoded="$(jq -Rn --arg value "$targets" '$value')"
temporary=".env.recovery-targets.$$"
awk -v replacement="MONITOR_AGENT_TARGETS=$encoded" '
  /^MONITOR_AGENT_TARGETS=/ { print replacement; next }
  { print }
' .env >"$temporary"
chmod 600 "$temporary"

docker compose stop monitor-service
mv "$temporary" .env
chmod 0600 .generated/prometheus.yml
command cp "$PROMETHEUS_FILE" .generated/prometheus.yml
chown 65534:65534 .generated/prometheus.yml
chmod 0400 .generated/prometheus.yml
if docker compose config -q \
  && docker compose exec -T prometheus promtool check config /etc/prometheus/prometheus.yml >/dev/null \
  && docker compose up -d --force-recreate monitor-service; then
  for _ in $(seq 1 60); do
    if [[ "$(docker inspect scorecheck-monitor-service --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)" == "healthy" ]] \
      && curl -fsS --max-time 5 -X POST http://127.0.0.1:9090/-/reload >/dev/null \
      && curl -fsS --max-time 5 http://127.0.0.1:9090/-/ready >/dev/null \
      && [[ "$(docker compose ps -q prometheus)" == "$prometheus_before" ]] \
      && cmp -s "$PROMETHEUS_FILE" .generated/prometheus.yml; then
      rm -f "$TARGET_FILE" "$PROMETHEUS_FILE"
      echo "Monitoring and Prometheus targets replaced and healthy."
      exit 0
    fi
    sleep 1
  done
fi

docker compose stop monitor-service >/dev/null 2>&1 || true
cp "$backup" .env
chmod 0600 .generated/prometheus.yml
command cp "$prometheus_backup" .generated/prometheus.yml
chown 65534:65534 .generated/prometheus.yml
chmod 0400 .generated/prometheus.yml
docker compose up -d --force-recreate monitor-service >/dev/null 2>&1 || true
curl -fsS --max-time 5 -X POST http://127.0.0.1:9090/-/reload >/dev/null 2>&1 || true
echo "error: monitoring target replacement failed; previous environment and Prometheus config restored" >&2
exit 1
