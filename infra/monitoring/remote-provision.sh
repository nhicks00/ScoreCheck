#!/usr/bin/env bash

set -euo pipefail
umask 077

REMOTE_DIR="${REMOTE_DIR:?REMOTE_DIR is required}"
CANDIDATE_DIR="${CANDIDATE_DIR:?CANDIDATE_DIR is required}"
REVISION="${REVISION:?REVISION is required}"

[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo "REVISION must be a full Git SHA." >&2; exit 1; }
case "$CANDIDATE_DIR" in
  "$REMOTE_DIR"/.incoming/*) ;;
  *) echo "Candidate directory is outside the protected incoming root." >&2; exit 1 ;;
esac

for command in curl diff docker flock install jq rsync seq; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required provisioning command is missing: $command." >&2; exit 1; }
done

cd "$REMOTE_DIR"
exec 9>/var/lock/scorecheck-monitoring-deploy.lock
flock -n 9 || { echo "Another observability deployment is already running." >&2; exit 1; }

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose is not installed." >&2
  exit 1
fi

retry_docker_operation() {
  local attempt=1 delay_seconds=2 status
  while true; do
    if "$@"; then return 0; else status=$?; fi
    if (( attempt >= 5 )); then return "$status"; fi
    echo "Docker image acquisition failed (attempt $attempt/5); retrying in ${delay_seconds}s." >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
    delay_seconds=$((delay_seconds * 2))
  done
}

candidate_image="scorecheck-monitoring:provision-${REVISION:0:12}-$$"
inhibition_container="scorecheck-alertmanager-provision-$$"
cutover_started=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  docker rm -f "$inhibition_container" >/dev/null 2>&1 || true
  if [[ "$status" -ne 0 && "$cutover_started" -eq 1 ]]; then
    echo "First observability provisioning failed; removing the partial stack." >&2
    (cd "$REMOTE_DIR" && compose down --volumes --remove-orphans) >/dev/null 2>&1 || true
    docker image rm scorecheck-monitoring:local >/dev/null 2>&1 || true
    rm -rf "$REMOTE_DIR/src" "$REMOTE_DIR/rules" "$REMOTE_DIR/.generated"
    rm -f "$REMOTE_DIR/.dockerignore" "$REMOTE_DIR/Caddyfile" "$REMOTE_DIR/Dockerfile" \
      "$REMOTE_DIR/docker-compose.yml" "$REMOTE_DIR/package.json" "$REMOTE_DIR/package-lock.json" \
      "$REMOTE_DIR/remote-deploy.sh" "$REMOTE_DIR/remote-provision.sh" \
      "$REMOTE_DIR/test-alertmanager-inhibition.mjs" "$REMOTE_DIR/tsconfig.json" "$REMOTE_DIR/.env"
  fi
  docker image rm "$candidate_image" >/dev/null 2>&1 || true
  rm -rf "$CANDIDATE_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

live_paths=(docker-compose.yml Caddyfile .env .generated/prometheus.yml .generated/alertmanager.yml rules src)
for path in "${live_paths[@]}"; do
  if [[ -e "$REMOTE_DIR/$path" ]]; then
    echo "First provisioning requires an empty observability baseline; found $path." >&2
    exit 1
  fi
done
for path in .dockerignore docker-compose.yml Caddyfile .env Dockerfile package.json package-lock.json \
  tsconfig.json test-alertmanager-inhibition.mjs remote-deploy.sh remote-provision.sh \
  .generated/prometheus.yml .generated/alertmanager.yml rules src; do
  [[ -e "$CANDIDATE_DIR/$path" ]] || { echo "Candidate is incomplete at $path." >&2; exit 1; }
done

prometheus_image='prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893'
alertmanager_image='prom/alertmanager:v0.33.1@sha256:9e082985f56f4c8c9f724e18f2288c6708f472e56a5286b8863d080434ea065d'
node_exporter_image='prom/node-exporter:v1.12.0@sha256:9b0ade5e607f9dbedb0a8e11151b6011ae5bd79304c261804cfdd2cadf200a80'
caddy_image='caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648'
node_image='node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2'

for image in "$prometheus_image" "$alertmanager_image" "$node_exporter_image" "$caddy_image" "$node_image"; do
  retry_docker_operation docker pull --quiet "$image"
done

chmod 0444 "$CANDIDATE_DIR/.generated/prometheus.yml" "$CANDIDATE_DIR/.generated/alertmanager.yml"
(cd "$CANDIDATE_DIR" && compose config -q)
docker run --rm --network none --read-only --cap-drop ALL --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --entrypoint promtool -w /rules -v "$CANDIDATE_DIR/rules:/rules:ro" \
  "$prometheus_image" check rules /rules/scorecheck.rules.yml >/dev/null
docker run --rm --network none --read-only --cap-drop ALL --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --entrypoint promtool -w /rules -v "$CANDIDATE_DIR/rules:/rules:ro" \
  "$prometheus_image" test rules /rules/scorecheck.rules.test.yml >/dev/null
docker run --rm --network none --read-only --cap-drop ALL --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --user 0:0 --entrypoint promtool \
  -v "$CANDIDATE_DIR/.generated/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$CANDIDATE_DIR/rules:/etc/prometheus/rules:ro" \
  "$prometheus_image" check config /etc/prometheus/prometheus.yml >/dev/null
docker run --rm --network none --read-only --cap-drop ALL --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --user 0:0 --entrypoint amtool \
  -v "$CANDIDATE_DIR/.generated/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
  "$alertmanager_image" check-config /etc/alertmanager/alertmanager.yml >/dev/null

docker run -d --name "$inhibition_container" --network none --read-only --cap-drop ALL \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m --tmpfs /alertmanager:rw,noexec,nosuid,nodev,size=32m \
  --user 0:0 -v "$CANDIDATE_DIR/.generated/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
  "$alertmanager_image" --config.file=/etc/alertmanager/alertmanager.yml --storage.path=/alertmanager \
  --cluster.listen-address= >/dev/null
docker run --rm --network "container:$inhibition_container" --read-only --cap-drop ALL \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  -v "$CANDIDATE_DIR/test-alertmanager-inhibition.mjs:/test-alertmanager-inhibition.mjs:ro" \
  "$node_image" node /test-alertmanager-inhibition.mjs
docker rm -f "$inhibition_container" >/dev/null

retry_docker_operation docker build --pull --label "org.opencontainers.image.revision=$REVISION" \
  --tag "$candidate_image" "$CANDIDATE_DIR"

install -d -m 0700 "$REMOTE_DIR/.generated"
install -m 0600 "$CANDIDATE_DIR/.env" "$REMOTE_DIR/.env"
install -m 0400 -o 65534 -g 65534 "$CANDIDATE_DIR/.generated/prometheus.yml" "$REMOTE_DIR/.generated/prometheus.yml"
install -m 0444 "$CANDIDATE_DIR/.generated/alertmanager.yml" "$REMOTE_DIR/.generated/alertmanager.yml"
rsync -a --delete "$CANDIDATE_DIR/rules/" "$REMOTE_DIR/rules/"
rsync -a --delete "$CANDIDATE_DIR/src/" "$REMOTE_DIR/src/"
for path in .dockerignore Caddyfile Dockerfile docker-compose.yml package.json package-lock.json test-alertmanager-inhibition.mjs tsconfig.json; do
  install -m 0644 "$CANDIDATE_DIR/$path" "$REMOTE_DIR/$path"
done
install -m 0755 "$CANDIDATE_DIR/remote-deploy.sh" "$REMOTE_DIR/remote-deploy.sh"
install -m 0755 "$CANDIDATE_DIR/remote-provision.sh" "$REMOTE_DIR/remote-provision.sh"
docker tag "$candidate_image" scorecheck-monitoring:local

cutover_started=1
(cd "$REMOTE_DIR" && compose up -d --no-build --remove-orphans)

public_host="$(grep -m 1 '^MONITOR_PUBLIC_HOST=' "$REMOTE_DIR/.env" | cut -d= -f2- | jq -Rer 'fromjson | select(type == "string" and length > 0)')"
[[ "$public_host" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || { echo "MONITOR_PUBLIC_HOST is invalid." >&2; exit 1; }
for _attempt in $(seq 1 90); do
  monitor_container="$(cd "$REMOTE_DIR" && compose ps -q monitor-service 2>/dev/null || true)"
  monitor_revision="$(docker inspect "$monitor_container" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
  monitor_health="$(docker inspect "$monitor_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
  running_count="$(cd "$REMOTE_DIR" && compose ps --status running -q 2>/dev/null | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$monitor_revision" == "$REVISION" && "$monitor_health" == "healthy" && "$running_count" == "5" ]] \
    && curl -fsS --max-time 5 http://127.0.0.1:9090/-/ready >/dev/null 2>&1 \
    && curl -fsS --max-time 5 http://127.0.0.1:9093/-/ready >/dev/null 2>&1 \
    && curl -fsS --max-time 10 "https://$public_host/healthz" \
      | jq -e '.status == "ok" and .version == 3' >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

monitor_container="$(cd "$REMOTE_DIR" && compose ps -q monitor-service)"
[[ "$(docker inspect "$monitor_container" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$REVISION" ]]
[[ "$(docker inspect "$monitor_container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" == "healthy" ]]
[[ "$(cd "$REMOTE_DIR" && compose ps --status running -q | sed '/^$/d' | wc -l | tr -d ' ')" == "5" ]]
curl -fsS --max-time 10 http://127.0.0.1:9090/api/v1/rules \
  | jq -e '.status == "success" and ([.data.groups[].rules[]] | length > 0)' >/dev/null
curl -fsS --retry 30 --retry-all-errors --retry-delay 2 --retry-max-time 120 \
  --connect-timeout 5 --max-time 10 "https://$public_host/healthz" \
  | jq -e '.status == "ok" and .version == 3' >/dev/null

cutover_started=0
docker image rm "$candidate_image" >/dev/null 2>&1 || true
rm -rf "$CANDIDATE_DIR"
trap - EXIT INT TERM HUP
echo "ScoreCheck first observability provisioning healthy revision=$REVISION"
