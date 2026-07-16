#!/usr/bin/env bash

set -euo pipefail
umask 077

REMOTE_DIR="${REMOTE_DIR:?REMOTE_DIR is required}"
CANDIDATE_DIR="${CANDIDATE_DIR:?CANDIDATE_DIR is required}"
REVISION="${REVISION:?REVISION is required}"

if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "REVISION must be a full Git SHA." >&2
  exit 1
fi
case "$CANDIDATE_DIR" in
  "$REMOTE_DIR"/.incoming/*) ;;
  *)
    echo "Candidate directory is outside the protected incoming root." >&2
    exit 1
    ;;
esac

for command in cmp curl cut diff docker flock grep install jq rsync seq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required deployment command is missing: $command." >&2
    exit 1
  fi
done

cd "$REMOTE_DIR"
exec 9>/var/lock/scorecheck-monitoring-deploy.lock
if ! flock -n 9; then
  echo "Another observability deployment is already running." >&2
  exit 1
fi

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
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if (( attempt >= 5 )); then
      return "$status"
    fi
    echo "Docker image acquisition failed (attempt $attempt/5); retrying in ${delay_seconds}s." >&2
    sleep "$delay_seconds"
    attempt=$((attempt + 1))
    delay_seconds=$((delay_seconds * 2))
  done
}

candidate_image="scorecheck-monitoring:candidate-${REVISION:0:12}-$$"
rollback_image="scorecheck-monitoring:rollback-${REVISION:0:12}-$$"
monitoring_contract_version=3
inhibition_container="scorecheck-alertmanager-preflight-$$"
backup_dir=""
rollback_required=0
old_revision=""
monitor_before=""
prometheus_before=""
alertmanager_before=""
caddy_before=""
node_exporter_before=""
provenance_paths=(
  .dockerignore
  Dockerfile
  package.json
  package-lock.json
  remote-deploy.sh
  test-alertmanager-inhibition.mjs
  tsconfig.json
)

wait_for_monitor() {
  local expected_revision="$1"
  local container revision health restart_count
  for _attempt in $(seq 1 60); do
    container="$(compose ps -q monitor-service 2>/dev/null || true)"
    if [[ -n "$container" ]]; then
      revision="$(docker inspect "$container" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"
      health="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)"
      restart_count="$(docker inspect "$container" --format '{{.RestartCount}}' 2>/dev/null || true)"
      if [[ "$revision" == "$expected_revision" && "$health" == "healthy" && "$restart_count" == "0" ]]; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

assert_static_container_ids() {
  local service before_variable current
  for service in prometheus alertmanager caddy node-exporter; do
    before_variable="${service//-/_}_before"
    current="$(compose ps -q "$service")"
    if [[ -z "$current" || "$current" != "${!before_variable}" ]]; then
      echo "Unexpected container replacement: $service." >&2
      return 1
    fi
  done
}

read_json_env_value() {
  local name="$1"
  local file="$2"
  local encoded
  encoded="$(grep -m 1 -E "^${name}=" "$file" | cut -d= -f2-)" || return 1
  if [[ "${encoded:0:1}" == '"' ]]; then
    printf '%s\n' "$encoded" | jq -Rer 'fromjson | select(type == "string" and length > 0)'
    return
  fi
  # The first staged cutover may encounter the former raw hostname format.
  # Accept only that strict non-secret value; never evaluate arbitrary env text.
  if [[ "$name" == "MONITOR_PUBLIC_HOST" && "$encoded" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    printf '%s\n' "$encoded"
    return
  fi
  return 1
}

assert_public_health() {
  local public_host
  public_host="$(read_json_env_value MONITOR_PUBLIC_HOST "$REMOTE_DIR/.env")"
  if [[ ! "$public_host" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
    echo "MONITOR_PUBLIC_HOST is invalid." >&2
    return 1
  fi
  curl --fail --silent --show-error --max-time 10 \
    "https://${public_host}/healthz" \
    | jq -e --argjson version "$monitoring_contract_version" \
      '.status == "ok" and .version == $version' >/dev/null
}

wait_for_public_health() {
  for _attempt in $(seq 1 30); do
    if assert_public_health >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Public monitor health did not become ready within 60 seconds." >&2
  return 1
}

wait_for_prometheus_monitor() {
  local minimum_sample_epoch="$1"
  local payload
  if [[ ! "$minimum_sample_epoch" =~ ^[0-9]+$ ]]; then
    echo "Prometheus monitor sample boundary is invalid." >&2
    return 1
  fi
  for _attempt in $(seq 1 30); do
    payload="$(curl --fail --silent --show-error --max-time 10 \
      'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22monitor-service%22%7D' 2>/dev/null || true)"
    if printf '%s' "$payload" | jq -e --argjson minimum "$minimum_sample_epoch" '
      .status == "success"
      and (.data.result | length) == 1
      and (.data.result[0].value[0] | tonumber) >= $minimum
      and .data.result[0].value[1] == "1"
    ' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  echo "Prometheus did not observe a successful post-cutover monitor-service scrape within 60 seconds." >&2
  return 1
}

assert_control_plane_ready() {
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:9090/-/ready >/dev/null
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:9093/-/ready >/dev/null
  assert_static_container_ids
}

restore_provenance() {
  local path
  rsync -a --delete "$backup_dir/src/" "$REMOTE_DIR/src/"
  for path in "${provenance_paths[@]}"; do
    if grep -Fxq "$path" "$backup_dir/provenance-present"; then
      install -d "$(dirname "$REMOTE_DIR/$path")"
      command cp -a "$backup_dir/provenance/$path" "$REMOTE_DIR/$path"
    else
      rm -f "$REMOTE_DIR/$path"
    fi
  done
}

restore_previous() {
  local failed=0
  install -m 0600 "$backup_dir/.env" "$REMOTE_DIR/.env" || failed=1
  rsync -a --delete "$backup_dir/rules/" "$REMOTE_DIR/rules/" || failed=1
  command cp "$backup_dir/.generated/prometheus.yml" "$REMOTE_DIR/.generated/prometheus.yml" || failed=1
  chown 65534:65534 "$REMOTE_DIR/.generated/prometheus.yml" || failed=1
  chmod 0400 "$REMOTE_DIR/.generated/prometheus.yml" || failed=1
  restore_provenance || failed=1
  docker tag "$rollback_image" scorecheck-monitoring:local || failed=1
  compose up -d --no-deps --force-recreate --no-build monitor-service || failed=1
  wait_for_monitor "$old_revision" || failed=1
  curl --fail --silent --show-error --max-time 10 \
    -X POST http://127.0.0.1:9090/-/reload >/dev/null || failed=1
  assert_control_plane_ready || failed=1
  wait_for_public_health || failed=1
  return "$failed"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  docker rm -f "$inhibition_container" >/dev/null 2>&1 || true
  if [[ "$rollback_required" == "1" ]]; then
    echo "Staged deployment failed; restoring the previous monitor-service and rules." >&2
    if ! restore_previous; then
      echo "Automatic rollback requires operator attention." >&2
      status=1
    fi
  fi
  docker image rm "$candidate_image" >/dev/null 2>&1 || true
  docker image rm "$rollback_image" >/dev/null 2>&1 || true
  rm -rf "$CANDIDATE_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

for path in \
  docker-compose.yml Caddyfile .env .generated/prometheus.yml \
  .generated/alertmanager.yml rules src; do
  if [[ ! -e "$REMOTE_DIR/$path" ]]; then
    echo "Live observability stack is incomplete at $path; use provisioning instead." >&2
    exit 1
  fi
done
for path in \
  .dockerignore docker-compose.yml Caddyfile .env Dockerfile package.json \
  package-lock.json tsconfig.json test-alertmanager-inhibition.mjs \
  remote-deploy.sh .generated/prometheus.yml .generated/alertmanager.yml \
  rules src; do
  if [[ ! -e "$CANDIDATE_DIR/$path" ]]; then
    echo "Candidate is incomplete at $path." >&2
    exit 1
  fi
done

# Routine releases must not silently become infrastructure cutovers. Caddy,
# Alertmanager, and Compose topology changes require a separately reviewed plan.
for path in docker-compose.yml Caddyfile .generated/alertmanager.yml; do
  if ! cmp -s "$REMOTE_DIR/$path" "$CANDIDATE_DIR/$path"; then
    echo "Routine deployment rejected infrastructure change at $path." >&2
    exit 1
  fi
done

# The incoming root is mode 0700, so these files remain host-private. Grant the
# isolated validation containers read access without evaluating or copying any
# protected value into a Docker build layer.
chmod 0444 \
  "$CANDIDATE_DIR/.generated/prometheus.yml" \
  "$CANDIDATE_DIR/.generated/alertmanager.yml"

prometheus_image='prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893'
alertmanager_image='prom/alertmanager:v0.33.1@sha256:9e082985f56f4c8c9f724e18f2288c6708f472e56a5286b8863d080434ea065d'
node_image='node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2'

retry_docker_operation docker pull --quiet "$prometheus_image"
retry_docker_operation docker pull --quiet "$alertmanager_image"
retry_docker_operation docker pull --quiet "$node_image"

docker run --rm --network none --read-only --cap-drop ALL \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --entrypoint promtool \
  -w /rules -v "$CANDIDATE_DIR/rules:/rules:ro" \
  "$prometheus_image" check rules /rules/scorecheck.rules.yml
docker run --rm --network none --read-only --cap-drop ALL \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --entrypoint promtool \
  -w /rules -v "$CANDIDATE_DIR/rules:/rules:ro" \
  "$prometheus_image" test rules /rules/scorecheck.rules.test.yml
docker run --rm --network none --read-only --cap-drop ALL \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --user 0:0 --entrypoint promtool \
  -v "$CANDIDATE_DIR/.generated/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$CANDIDATE_DIR/rules:/etc/prometheus/rules:ro" \
  "$prometheus_image" check config /etc/prometheus/prometheus.yml >/dev/null
docker run --rm --network none --read-only --cap-drop ALL \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --user 0:0 --entrypoint amtool \
  -v "$CANDIDATE_DIR/.generated/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
  "$alertmanager_image" check-config /etc/alertmanager/alertmanager.yml >/dev/null
(cd "$CANDIDATE_DIR" && compose config -q)

docker run -d --name "$inhibition_container" --network none --read-only --cap-drop ALL \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --tmpfs /alertmanager:rw,noexec,nosuid,nodev,size=32m \
  --user 0:0 \
  -v "$CANDIDATE_DIR/.generated/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
  "$alertmanager_image" \
  --config.file=/etc/alertmanager/alertmanager.yml \
  --storage.path=/alertmanager \
  --cluster.listen-address= >/dev/null
docker run --rm --network "container:$inhibition_container" --read-only --cap-drop ALL \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  -v "$CANDIDATE_DIR/test-alertmanager-inhibition.mjs:/test-alertmanager-inhibition.mjs:ro" \
  "$node_image" \
  node /test-alertmanager-inhibition.mjs
docker rm -f "$inhibition_container" >/dev/null

retry_docker_operation docker build --pull --label "org.opencontainers.image.revision=$REVISION" \
  --tag "$candidate_image" "$CANDIDATE_DIR"

monitor_before="$(compose ps -q monitor-service)"
prometheus_before="$(compose ps -q prometheus)"
alertmanager_before="$(compose ps -q alertmanager)"
caddy_before="$(compose ps -q caddy)"
node_exporter_before="$(compose ps -q node-exporter)"
for value in "$monitor_before" "$prometheus_before" "$alertmanager_before" "$caddy_before" "$node_exporter_before"; do
  if [[ -z "$value" || "$(docker inspect "$value" --format '{{.State.Running}}')" != "true" ]]; then
    echo "Every observability service must be running before a staged deployment." >&2
    exit 1
  fi
done

old_revision="$(docker inspect "$monitor_before" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
old_image_revision="$(docker image inspect scorecheck-monitoring:local --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
old_health="$(docker inspect "$monitor_before" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')"
old_restarts="$(docker inspect "$monitor_before" --format '{{.RestartCount}}')"
if [[ ! "$old_revision" =~ ^[0-9a-f]{40}$ || "$old_revision" != "$old_image_revision" \
  || "$old_health" != "healthy" || "$old_restarts" != "0" ]]; then
  echo "Current monitor-service is not a clean, revision-labeled rollback baseline." >&2
  exit 1
fi
assert_static_container_ids

wait_for_public_health
assert_control_plane_ready

timestamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backup_dir="$REMOTE_DIR/backups/staged-$timestamp"
install -d -m 0700 \
  "$backup_dir/.generated" "$backup_dir/provenance" \
  "$backup_dir/rules" "$backup_dir/src"
install -m 0600 "$REMOTE_DIR/.env" "$backup_dir/.env"
install -m 0400 "$REMOTE_DIR/.generated/prometheus.yml" "$backup_dir/.generated/prometheus.yml"
rsync -a --delete "$REMOTE_DIR/rules/" "$backup_dir/rules/"
rsync -a --delete "$REMOTE_DIR/src/" "$backup_dir/src/"
: >"$backup_dir/provenance-present"
for path in "${provenance_paths[@]}"; do
  if [[ -e "$REMOTE_DIR/$path" ]]; then
    install -d "$backup_dir/provenance/$(dirname "$path")"
    command cp -a "$REMOTE_DIR/$path" "$backup_dir/provenance/$path"
    printf '%s\n' "$path" >>"$backup_dir/provenance-present"
  fi
done

docker image inspect scorecheck-monitoring:local >/dev/null
docker tag scorecheck-monitoring:local "$rollback_image"

rollback_required=1
install -m 0600 "$CANDIDATE_DIR/.env" "$REMOTE_DIR/.env"
docker tag "$candidate_image" scorecheck-monitoring:local
candidate_cutover_epoch="$(date +%s)"
compose up -d --no-deps --force-recreate --no-build monitor-service
if ! wait_for_monitor "$REVISION"; then
  compose logs --tail=120 monitor-service >&2 || true
  exit 1
fi

wait_for_public_health

# Only after the new service is healthy may matching rules and scrape config go live.
rsync -a --delete "$CANDIDATE_DIR/rules/" "$REMOTE_DIR/rules/"
command cp "$CANDIDATE_DIR/.generated/prometheus.yml" "$REMOTE_DIR/.generated/prometheus.yml"
chown 65534:65534 "$REMOTE_DIR/.generated/prometheus.yml"
chmod 0400 "$REMOTE_DIR/.generated/prometheus.yml"
diff -qr "$CANDIDATE_DIR/rules" "$REMOTE_DIR/rules" >/dev/null
cmp -s "$CANDIDATE_DIR/.generated/prometheus.yml" "$REMOTE_DIR/.generated/prometheus.yml"
curl --fail --silent --show-error --max-time 10 \
  -X POST http://127.0.0.1:9090/-/reload >/dev/null
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:9090/-/ready >/dev/null
curl --fail --silent --show-error --max-time 10 \
  http://127.0.0.1:9090/api/v1/rules \
  | jq -e '.status == "success" and ([.data.groups[].rules[]] | length > 0)' >/dev/null
wait_for_prometheus_monitor "$candidate_cutover_epoch"
assert_control_plane_ready

for path in .dockerignore Dockerfile package.json package-lock.json test-alertmanager-inhibition.mjs tsconfig.json; do
  install -m 0644 "$CANDIDATE_DIR/$path" "$REMOTE_DIR/$path"
done
install -m 0755 "$CANDIDATE_DIR/remote-deploy.sh" "$REMOTE_DIR/remote-deploy.sh"
rsync -a --delete "$CANDIDATE_DIR/src/" "$REMOTE_DIR/src/"
diff -qr "$CANDIDATE_DIR/src" "$REMOTE_DIR/src" >/dev/null
for path in .dockerignore Dockerfile package.json package-lock.json remote-deploy.sh test-alertmanager-inhibition.mjs tsconfig.json; do
  cmp -s "$CANDIDATE_DIR/$path" "$REMOTE_DIR/$path"
done

monitor_after="$(compose ps -q monitor-service)"
if [[ -z "$monitor_after" || "$monitor_after" == "$monitor_before" ]]; then
  echo "monitor-service was not recreated." >&2
  exit 1
fi
wait_for_monitor "$REVISION"
assert_static_container_ids

rollback_required=0
docker image rm "$candidate_image" >/dev/null 2>&1 || true
docker image rm "$rollback_image" >/dev/null 2>&1 || true
rm -rf "$CANDIDATE_DIR"
trap - EXIT INT TERM HUP
echo "ScoreCheck staged observability deployment healthy revision=$REVISION"
