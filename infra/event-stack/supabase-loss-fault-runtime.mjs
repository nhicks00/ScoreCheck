import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { runCommand } from "./stack-deployer.mjs";

const REMOTE_ROOT = "/opt/scorecheck-monitoring";
const CADDY_PATH = `${REMOTE_ROOT}/Caddyfile`;
const MARKER_PATH = `${REMOTE_ROOT}/.scorecheck-supabase-fault-gate.json`;
const BACKUP_PATH = `${REMOTE_ROOT}/.scorecheck-supabase-fault-Caddyfile`;
const PROXY_SCRIPT = `${REMOTE_ROOT}/fault-gates/supabase-fault-proxy.mjs`;
const SERVICE_SCRIPT = `${REMOTE_ROOT}/fault-gates/supabase-fault-proxy-service.mjs`;
const PROXY_PORT = 54329;
const ROLE_LABEL = "scorecheck-supabase-fault-proxy";

export class SupabaseLossFaultRuntime {
  constructor({ sshKey, knownHosts, runner = runCommand, fetchImpl = globalThis.fetch } = {}) {
    this.sshKey = protectedAbsolute(sshKey, "SSH private key");
    this.knownHosts = protectedAbsolute(knownHosts, "known_hosts path");
    if (typeof runner !== "function" || typeof fetchImpl !== "function") throw new Error("Supabase-loss runtime dependency is invalid");
    Object.assign(this, { runner, fetchImpl });
  }

  plan({ host, publicHost, event, generationId, upstreamOrigin, caddyfile, proxyScript, serviceScript }) {
    assertIpv4(host);
    const target = {
      schemaVersion: 1,
      host,
      publicHost: externalHostname(publicHost),
      event: identifier(event, "event"),
      generationId: generation(generationId),
      gateId: `supabase-loss-${randomUUID()}`,
      upstreamOrigin: upstream(upstreamOrigin),
      caddyfile: requiredText(caddyfile, "Caddyfile"),
      proxyScriptSha256: sha256(requiredText(proxyScript, "Supabase fault proxy script")),
      serviceScriptSha256: sha256(requiredText(serviceScript, "Supabase fault proxy service script"))
    };
    target.pathPrefix = supabaseFaultPathPrefix(target.event);
    target.publicOrigin = `https://${target.publicHost}${target.pathPrefix}`;
    target.containerName = `scorecheck-supabase-fault-${sha256(target.gateId).slice(0, 12)}`;
    target.stateDirectory = `${REMOTE_ROOT}/.supabase-fault/${target.containerName}`;
    target.baselineConfigSha256 = sha256(target.caddyfile);
    const candidate = buildSupabaseFaultCaddyfile(target.caddyfile, target.pathPrefix, PROXY_PORT);
    target.faultConfigSha256 = sha256(candidate);
    target.faultConfigBase64 = Buffer.from(candidate).toString("base64");
    const marker = stableJson({
      schemaVersion: 1,
      event: target.event,
      generationId: target.generationId,
      gateId: target.gateId,
      containerName: target.containerName,
      pathPrefix: target.pathPrefix,
      baselineConfigSha256: target.baselineConfigSha256,
      faultConfigSha256: target.faultConfigSha256
    });
    const markerBody = `${marker}\n`;
    target.markerSha256 = sha256(markerBody);
    target.markerBase64 = Buffer.from(markerBody).toString("base64");
    delete target.caddyfile;
    return validateTarget(target);
  }

  async inspect(target) {
    const value = validateTarget(target);
    const result = await this.#ssh(value.host, inspectCommand(value));
    let payload;
    try { payload = JSON.parse(result.stdout.trim()); }
    catch { throw new Error("Supabase-loss host inspection returned invalid JSON"); }
    if (payload?.status === "CLEAN") return { status: "CLEAN", checkedAt: new Date().toISOString(), service: null };
    if (payload?.status === "DIRTY") return { status: "DIRTY", checkedAt: new Date().toISOString(), service: null };
    if (payload?.status !== "BOUND") throw new Error("Supabase-loss host inspection status is invalid");
    const service = validateServiceSnapshot(payload.state, value);
    return { status: service.status, checkedAt: new Date().toISOString(), service };
  }

  async prepare({ target, confirmation }) {
    const value = validateTarget(target);
    requireConfirmation(confirmation, `PREPARE-SUPABASE-FAULT:${value.event}`);
    const before = await this.inspect(value);
    if (before.status === "HEALTHY") {
      await this.#verifyPublicHealth(value);
      return { status: "HEALTHY", adopted: true, preparedAt: null, service: before.service };
    }
    if (before.status !== "CLEAN") throw new Error(`Supabase-loss preparation cannot start from ${before.status}`);
    try {
      await this.#ssh(value.host, prepareCommand(value));
      const after = await this.inspect(value);
      if (after.status !== "HEALTHY") throw new Error(`Supabase-loss preparation did not converge: ${after.status}`);
      await this.#verifyPublicHealth(value);
      return { status: "HEALTHY", adopted: false, preparedAt: new Date().toISOString(), service: after.service };
    } catch (error) {
      const cleanup = await this.#cleanupRemote(value).catch((cleanupError) => ({ status: "FAILED", error: safeError(cleanupError) }));
      const wrapped = new Error(`Supabase-loss preparation failed: ${error instanceof Error ? error.message : String(error)}`);
      wrapped.cleanup = cleanup;
      throw wrapped;
    }
  }

  async fault({ target, confirmation }) {
    const value = validateTarget(target);
    requireConfirmation(confirmation, `FAULT-SUPABASE:${value.generationId}`);
    const before = await this.inspect(value);
    if (before.status === "FAULTED") return { status: "FAULTED", adopted: true, faultedAt: before.service.faultedAt, service: before.service };
    if (before.status !== "HEALTHY") throw new Error(`Supabase-loss fault requires HEALTHY, got ${before.status}`);
    await this.#ssh(value.host, controlCommand(value, "USR1", "FAULTED"));
    const after = await this.inspect(value);
    if (after.status !== "FAULTED" || after.service.counters.faultCount !== before.service.counters.faultCount + 1) throw new Error("Supabase-loss fault did not converge exactly once");
    return { status: "FAULTED", adopted: false, faultedAt: after.service.faultedAt, service: after.service };
  }

  async restore({ target, confirmation }) {
    const value = validateTarget(target);
    requireConfirmation(confirmation, `RESTORE-SUPABASE:${value.generationId}`);
    const before = await this.inspect(value);
    if (before.status === "HEALTHY") {
      await this.#verifyPublicHealth(value);
      return { status: "HEALTHY", adopted: true, restoredAt: before.service?.restoredAt ?? null, service: before.service };
    }
    if (before.status !== "FAULTED") throw new Error(`Supabase-loss restore requires FAULTED, got ${before.status}`);
    await this.#ssh(value.host, controlCommand(value, "USR2", "HEALTHY"));
    const after = await this.inspect(value);
    if (after.status !== "HEALTHY" || after.service.counters.restoreCount !== before.service.counters.restoreCount + 1) throw new Error("Supabase-loss restore did not converge exactly once");
    await this.#verifyPublicHealth(value);
    return { status: "HEALTHY", adopted: false, restoredAt: after.service.restoredAt, service: after.service };
  }

  async cleanup({ target, confirmation }) {
    const value = validateTarget(target);
    requireConfirmation(confirmation, `CLEANUP-SUPABASE-FAULT:${value.event}`);
    return this.#cleanupRemote(value);
  }

  async #cleanupRemote(target) {
    const before = await this.inspect(target);
    if (before.status === "CLEAN") return { status: "CLEAN", adopted: true, cleanedAt: null };
    await this.#ssh(target.host, cleanupCommand(target));
    const after = await this.inspect(target);
    if (after.status !== "CLEAN") throw new Error(`Supabase-loss cleanup did not converge: ${after.status}`);
    return { status: "CLEAN", adopted: false, cleanedAt: new Date().toISOString() };
  }

  async #verifyPublicHealth(target) {
    const response = await this.fetchImpl(`${target.publicOrigin}__healthz`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => null);
    if (response.status !== 200 || body?.status !== "HEALTHY") throw new Error(`Supabase-loss public TLS route returned HTTP ${response.status}`);
  }

  #ssh(host, command) {
    return this.runner("ssh", [
      "-i", this.sshKey,
      "-o", "BatchMode=yes",
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}`,
      command
    ], { timeoutMs: 180_000 });
  }
}

export function buildSupabaseFaultCaddyfile(baseline, pathPrefix, port = PROXY_PORT) {
  const source = requiredText(baseline, "Caddyfile");
  if (source.includes("scorecheckSupabaseFault")) throw new Error("Caddyfile already contains a Supabase fault route");
  if (typeof pathPrefix !== "string" || !/^\/_scorecheck-supabase-fault\/[A-Za-z0-9][A-Za-z0-9._-]{2,127}\/$/u.test(pathPrefix)) throw new Error("Supabase fault Caddy path prefix is invalid");
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("Supabase fault proxy port is invalid");
  const anchor = "\n\t@allowed path /healthz /v1/*";
  if (source.split(anchor).length !== 2) throw new Error("Caddyfile monitor route anchor is not unique");
  const route = `\n\t@scorecheckSupabaseFault path ${pathPrefix}*\n\thandle @scorecheckSupabaseFault {\n\t\treverse_proxy 127.0.0.1:${port}\n\t}\n`;
  return source.replace(anchor, `${route}${anchor}`);
}

export function supabaseFaultPathPrefix(event) {
  return `/_scorecheck-supabase-fault/${identifier(event, "event")}/`;
}

export function inspectCommand(target) {
  return shell(`
root=${q(REMOTE_ROOT)}
config=${q(CADDY_PATH)}
marker=${q(MARKER_PATH)}
backup=${q(BACKUP_PATH)}
state=${q(`${target.stateDirectory}/state.json`)}
name=${q(target.containerName)}
role=${q(ROLE_LABEL)}
for path in "$config" "$marker" "$backup" ${q(target.stateDirectory)}; do [ ! -L "$path" ] || { printf '{"status":"DIRTY"}\\n'; exit 0; }; done
current="$(sha256sum "$config" | awk '{print $1}')"
containers="$(docker ps -aq --filter label=com.scorecheck.role="$role")"
state_age=999999
if [ -f "$state" ]; then state_age="$(( $(date +%s) - $(stat -c %Y "$state") ))"; fi
if [ "$current" = ${q(target.baselineConfigSha256)} ] && [ ! -e "$marker" ] && [ ! -e "$backup" ] && [ ! -e ${q(target.stateDirectory)} ] && [ -z "$containers" ]; then
  printf '{"status":"CLEAN"}\\n'
  exit 0
fi
if [ "$current" = ${q(target.faultConfigSha256)} ] \
  && [ -f "$marker" ] && [ "$(sha256sum "$marker" | awk '{print $1}')" = ${q(target.markerSha256)} ] \
  && [ -f "$backup" ] && [ "$(sha256sum "$backup" | awk '{print $1}')" = ${q(target.baselineConfigSha256)} ] \
  && [ -f "$state" ] && [ "$state_age" -ge 0 ] && [ "$state_age" -le 5 ] \
  && [ "$(printf '%s\\n' "$containers" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ] \
  && docker inspect "$name" >/dev/null 2>&1 \
  && [ "$(docker inspect "$name" --format '{{.State.Running}}')" = true ] \
  && [ "$(docker inspect "$name" --format '{{index .Config.Labels "com.scorecheck.event"}}')" = ${q(target.event)} ] \
  && [ "$(docker inspect "$name" --format '{{index .Config.Labels "com.scorecheck.generation"}}')" = ${q(target.generationId)} ]; then
  printf '{"status":"BOUND","state":'
  cat "$state"
  printf '}\\n'
  exit 0
fi
printf '{"status":"DIRTY"}\\n'
`);
}

export function prepareCommand(target) {
  return shell(`
config=${q(CADDY_PATH)}
marker=${q(MARKER_PATH)}
backup=${q(BACKUP_PATH)}
state_dir=${q(target.stateDirectory)}
state="$state_dir/state.json"
name=${q(target.containerName)}
role=${q(ROLE_LABEL)}
proxy=${q(PROXY_SCRIPT)}
service=${q(SERVICE_SCRIPT)}
[ ! -L "$config" ] && [ ! -L "$marker" ] && [ ! -L "$backup" ] && [ ! -L "$state_dir" ]
[ "$(sha256sum "$config" | awk '{print $1}')" = ${q(target.baselineConfigSha256)} ]
[ ! -e "$marker" ] && [ ! -e "$backup" ] && [ ! -e "$state_dir" ]
[ -z "$(docker ps -aq --filter label=com.scorecheck.role="$role")" ]
[ -f "$proxy" ] && [ ! -L "$proxy" ] && [ "$(sha256sum "$proxy" | awk '{print $1}')" = ${q(target.proxyScriptSha256)} ]
[ -f "$service" ] && [ ! -L "$service" ] && [ "$(sha256sum "$service" | awk '{print $1}')" = ${q(target.serviceScriptSha256)} ]
caddy_id="$(docker ps -q --filter label=com.docker.compose.project=scorecheck-observability --filter label=com.docker.compose.service=caddy)"
monitor_id="$(docker ps -q --filter label=com.docker.compose.project=scorecheck-observability --filter label=com.docker.compose.service=monitor-service)"
[ "$(printf '%s\\n' "$caddy_id" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ]
[ "$(printf '%s\\n' "$monitor_id" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ]
image="$(docker inspect "$monitor_id" --format '{{.Image}}')"
install -d -m 0700 "$state_dir"
chown 1000:1000 "$state_dir"
cp "$config" "$backup"
chmod 0600 "$backup"
printf %s ${q(target.markerBase64)} | base64 -d > "$marker.tmp"
chmod 0600 "$marker.tmp"
mv "$marker.tmp" "$marker"
docker run --detach --rm --name "$name" \
  --label com.scorecheck.role="$role" \
  --label com.scorecheck.event=${q(target.event)} \
  --label com.scorecheck.generation=${q(target.generationId)} \
  --network "container:$caddy_id" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 128m \
  -v ${q(`${REMOTE_ROOT}/fault-gates`)}:/gate:ro -v "$state_dir":/state:rw \
  "$image" node /gate/supabase-fault-proxy-service.mjs \
  --upstream ${q(target.upstreamOrigin)} --event ${q(target.event)} --generation ${q(target.generationId)} \
  --path-prefix ${q(target.pathPrefix)} --state /state/state.json --port ${PROXY_PORT} >/dev/null
ready=0
for attempt in $(seq 1 150); do
  if [ -f "$state" ] && grep -Fq '"status":"HEALTHY"' "$state"; then ready=1; break; fi
  sleep 0.1
done
[ "$ready" = 1 ]
printf %s ${q(target.faultConfigBase64)} | base64 -d > "$config.tmp"
chmod --reference="$config" "$config.tmp"
chown --reference="$config" "$config.tmp"
mv "$config.tmp" "$config"
docker exec "$caddy_id" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
docker exec "$caddy_id" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
`);
}

export function controlCommand(target, signal, expectedStatus) {
  return shell(`
config=${q(CADDY_PATH)}
marker=${q(MARKER_PATH)}
state=${q(`${target.stateDirectory}/state.json`)}
name=${q(target.containerName)}
[ ! -L "$config" ] && [ ! -L "$marker" ] && [ ! -L ${q(target.stateDirectory)} ]
[ "$(sha256sum "$config" | awk '{print $1}')" = ${q(target.faultConfigSha256)} ]
[ -f "$marker" ] && [ "$(sha256sum "$marker" | awk '{print $1}')" = ${q(target.markerSha256)} ]
[ "$(docker inspect "$name" --format '{{.State.Running}}')" = true ]
docker kill --signal=${q(signal)} "$name" >/dev/null
ready=0
for attempt in $(seq 1 150); do
  if [ -f "$state" ] && grep -Fq ${q(`"status":"${expectedStatus}"`)} "$state"; then ready=1; break; fi
  sleep 0.1
done
[ "$ready" = 1 ]
`);
}

export function cleanupCommand(target) {
  return shell(`
config=${q(CADDY_PATH)}
marker=${q(MARKER_PATH)}
backup=${q(BACKUP_PATH)}
state_dir=${q(target.stateDirectory)}
name=${q(target.containerName)}
role=${q(ROLE_LABEL)}
for path in "$config" "$marker" "$backup" "$state_dir"; do [ ! -L "$path" ] || exit 61; done
current="$(sha256sum "$config" | awk '{print $1}')"
containers="$(docker ps -aq --filter label=com.scorecheck.role="$role")"
if [ -n "$containers" ]; then
  [ "$(printf '%s\\n' "$containers" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ]
  docker inspect "$name" >/dev/null 2>&1
  [ "$(docker inspect "$name" --format '{{index .Config.Labels "com.scorecheck.event"}}')" = ${q(target.event)} ]
  [ "$(docker inspect "$name" --format '{{index .Config.Labels "com.scorecheck.generation"}}')" = ${q(target.generationId)} ]
fi
if [ "$current" = ${q(target.faultConfigSha256)} ]; then
  [ -f "$marker" ] && [ "$(sha256sum "$marker" | awk '{print $1}')" = ${q(target.markerSha256)} ]
  [ -f "$backup" ] && [ "$(sha256sum "$backup" | awk '{print $1}')" = ${q(target.baselineConfigSha256)} ]
  caddy_id="$(docker ps -q --filter label=com.docker.compose.project=scorecheck-observability --filter label=com.docker.compose.service=caddy)"
  [ "$(printf '%s\\n' "$caddy_id" | sed '/^$/d' | wc -l | tr -d ' ')" = 1 ]
  cp "$backup" "$config.tmp"
  chmod --reference="$config" "$config.tmp"
  chown --reference="$config" "$config.tmp"
  mv "$config.tmp" "$config"
  docker exec "$caddy_id" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  docker exec "$caddy_id" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
elif [ "$current" != ${q(target.baselineConfigSha256)} ]; then
  exit 62
fi
if docker inspect "$name" >/dev/null 2>&1; then docker stop --time 10 "$name" >/dev/null; fi
rm -f "$marker" "$backup"
rm -rf "$state_dir"
[ "$(sha256sum "$config" | awk '{print $1}')" = ${q(target.baselineConfigSha256)} ]
[ -z "$(docker ps -aq --filter label=com.scorecheck.role="$role")" ]
`);
}

function validateTarget(value) {
  if (!value || value.schemaVersion !== 1) throw new Error("Supabase-loss target schema is invalid");
  assertIpv4(value.host);
  externalHostname(value.publicHost);
  identifier(value.event, "event");
  generation(value.generationId);
  if (!/^supabase-loss-[0-9a-f-]{36}$/u.test(value.gateId ?? "")) throw new Error("Supabase-loss gate id is invalid");
  upstream(value.upstreamOrigin);
  const expectedPrefix = supabaseFaultPathPrefix(value.event);
  if (value.pathPrefix !== expectedPrefix || value.publicOrigin !== `https://${value.publicHost}${expectedPrefix}`) throw new Error("Supabase-loss public proxy binding is invalid");
  if (!/^scorecheck-supabase-fault-[a-f0-9]{12}$/u.test(value.containerName ?? "")) throw new Error("Supabase-loss container name is invalid");
  if (value.stateDirectory !== `${REMOTE_ROOT}/.supabase-fault/${value.containerName}`) throw new Error("Supabase-loss state directory is invalid");
  for (const key of ["baselineConfigSha256", "faultConfigSha256", "markerSha256", "proxyScriptSha256", "serviceScriptSha256"]) if (!/^[a-f0-9]{64}$/u.test(value[key] ?? "")) throw new Error(`Supabase-loss ${key} is invalid`);
  for (const key of ["faultConfigBase64", "markerBase64"]) if (typeof value[key] !== "string" || !/^[A-Za-z0-9+/=]+$/u.test(value[key])) throw new Error(`Supabase-loss ${key} is invalid`);
  return value;
}

function validateServiceSnapshot(value, target) {
  if (!value || value.schemaVersion !== 1 || value.event !== target.event || value.generationId !== target.generationId || value.pathPrefix !== target.pathPrefix) throw new Error("Supabase-loss service snapshot binding is invalid");
  if (!new Set(["HEALTHY", "FAULTED"]).has(value.status)) throw new Error("Supabase-loss service state is invalid");
  if (!Number.isFinite(Date.parse(value.writtenAt)) || !Number.isFinite(Date.parse(value.startedAt))) throw new Error("Supabase-loss service timestamps are invalid");
  if (value.upstream?.protocol !== new URL(target.upstreamOrigin).protocol || value.upstream?.hostname !== new URL(target.upstreamOrigin).hostname) throw new Error("Supabase-loss service upstream changed");
  const counters = value.counters;
  for (const key of ["httpRequestsForwarded", "webSocketsForwarded", "requestsRejectedDuringFault", "upstreamErrors", "faultCount", "restoreCount", "activeHttpRequests", "pendingWebSocketUpgrades", "activeWebSockets"]) {
    if (!Number.isInteger(counters?.[key]) || counters[key] < 0) throw new Error(`Supabase-loss service counter ${key} is invalid`);
  }
  return value;
}

function shell(body) {
  return `set -eu\numask 077\n${body.trim()}\n`;
}

function q(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function safeError(error) {
  return { name: error instanceof Error ? error.name : "Error", message: (error instanceof Error ? error.message : String(error)).slice(0, 500) };
}

function upstream(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.origin !== value || parsed.username || parsed.password) throw new Error("Supabase-loss upstream must be a credential-free HTTPS origin");
  return parsed.origin;
}

function externalHostname(value) {
  if (typeof value !== "string" || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value)) throw new Error("Supabase-loss public host is invalid");
  return value;
}

function generation(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(value)) throw new Error("Supabase-loss generation is invalid");
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(value)) throw new Error(`Supabase-loss ${label} is invalid`);
  return value;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.length || /\0/u.test(value)) throw new Error(`${label} is required`);
  return value;
}

function protectedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function assertIpv4(value) {
  if (typeof value !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value) || value.split(".").some((part) => Number(part) > 255)) throw new Error("Supabase-loss host must be an IPv4 address");
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new Error(`confirmation must be exactly ${expected}`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
