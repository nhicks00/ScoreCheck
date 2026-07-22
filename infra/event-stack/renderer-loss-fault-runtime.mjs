import { createHash } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { isAbsolute, resolve } from "node:path";

import { validateRendererBinding } from "./renderer-binding.mjs";
import { runCommand } from "./stack-deployer.mjs";

const MARKER_PATH = "/opt/compositor/.scorecheck-renderer-loss-fault";

export class RendererLossFaultRuntime {
  constructor({ sshKey, knownHosts, runner = runCommand, resolver = resolve4 } = {}) {
    this.sshKey = protectedAbsolute(sshKey, "SSH private key");
    this.knownHosts = protectedAbsolute(knownHosts, "known_hosts path");
    if (typeof runner !== "function") throw new Error("renderer-loss runner is invalid");
    if (typeof resolver !== "function") throw new Error("renderer-loss resolver is invalid");
    this.runner = runner;
    this.resolver = resolver;
  }

  async plan({ host, event, camera, gateId, renderer, egressOwner }) {
    const binding = validateRendererBinding(renderer);
    const hostname = new URL(binding.origin).hostname;
    const destinations = uniqueIpv4(await this.resolver(hostname));
    if (destinations.length === 0 || destinations.length > 16) throw new Error("renderer origin must resolve to 1-16 IPv4 destinations");
    return validateTarget({
      schemaVersion: 1,
      host,
      event,
      camera,
      gateId,
      origin: binding.origin,
      rendererGitSha: binding.gitSha,
      rendererDeploymentId: binding.deploymentId,
      egressId: egressOwner?.egressId,
      destinationId: egressOwner?.destinationId,
      outputGeneration: egressOwner?.outputGeneration,
      chain: chainName(event, gateId, camera),
      destinations,
      resolvedAt: new Date().toISOString()
    });
  }

  async verifyDns(target) {
    const value = validateTarget(target);
    const current = uniqueIpv4(await this.resolver(new URL(value.origin).hostname));
    return {
      passed: JSON.stringify(current) === JSON.stringify(value.destinations),
      expected: value.destinations,
      current,
      checkedAt: new Date().toISOString()
    };
  }

  async inspect(target) {
    const value = validateTarget(target);
    const result = await this.#ssh(value.host, inspectCommand(value));
    const status = result.stdout.trim();
    if (!new Set(["HEALTHY", "FAULTED", "PARTIAL", "CONTAINER_DRIFT", "UNAVAILABLE"]).has(status)) {
      throw new Error("renderer-loss fault status is invalid");
    }
    return { status, checkedAt: new Date().toISOString() };
  }

  async inject({ target, confirmation }) {
    const value = validateTarget(target);
    requireConfirmation(confirmation, `FAULT-RENDERER:${value.event}:CAMERA-${value.camera}`);
    const before = await this.inspect(value);
    if (before.status === "FAULTED") return { status: "FAULTED", adopted: true, injectedAt: null };
    if (!new Set(["HEALTHY", "PARTIAL"]).has(before.status)) throw new Error(`renderer origin cannot be faulted from ${before.status}`);
    await this.#ssh(value.host, injectCommand(value));
    const after = await this.inspect(value);
    if (after.status !== "FAULTED") throw new Error(`renderer-loss fault did not converge: ${after.status}`);
    return { status: "FAULTED", adopted: false, injectedAt: new Date().toISOString() };
  }

  async restore({ target, confirmation }) {
    const value = validateTarget(target);
    requireConfirmation(confirmation, `RESTORE-RENDERER:${value.event}:CAMERA-${value.camera}`);
    const before = await this.inspect(value);
    if (before.status === "HEALTHY") return { status: "HEALTHY", adopted: true, restoredAt: null };
    if (!new Set(["FAULTED", "PARTIAL", "CONTAINER_DRIFT"]).has(before.status)) throw new Error(`renderer origin cannot be restored from ${before.status}`);
    await this.#ssh(value.host, restoreCommand(value));
    const after = await this.inspect(value);
    if (after.status !== "HEALTHY") throw new Error(`renderer-loss restoration cleaned its rules but compositor status is ${after.status}`);
    return { status: "HEALTHY", adopted: false, restoredAt: new Date().toISOString() };
  }

  #ssh(host, command) {
    assertIpv4(host);
    return this.runner("ssh", [
      "-i", this.sshKey,
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}`,
      command
    ]);
  }
}

export function inspectCommand(target) {
  const value = validateTarget(target);
  const staticIdentity = markerStaticIdentity(value);
  const destinations = value.destinations.join(",");
  const comment = chainComment(value);
  return [
    "scorecheck_renderer_loss_inspect=1",
    "set -eu",
    "cd /opt/compositor",
    `marker=${shellQuote(MARKER_PATH)}`,
    `chain=${shellQuote(value.chain)}`,
    `comment=${shellQuote(comment)}`,
    `expected_static=${shellQuote(staticIdentity)}`,
    `expected_destinations=${shellQuote(destinations)}`,
    `owner=${shellQuote(`requests/court-${value.camera}.owner.json`)}`,
    "if test -e \"$marker\"; then",
    "  test -f \"$marker\" && test ! -L \"$marker\" || exit 1",
    "  IFS='|' read -r marker_static marker_container_id marker_container_ip marker_destinations < \"$marker\"",
    "  test \"$marker_static\" = \"$expected_static\" && test \"$marker_destinations\" = \"$expected_destinations\" || exit 1",
    "  complete=1",
    "  iptables -S \"$chain\" >/dev/null 2>&1 || complete=0",
    "  if test \"$complete\" = 1; then",
    "    rule_count=$(iptables -S \"$chain\" | awk '$1 == \"-A\" { count += 1 } END { print count + 0 }')",
    `    test "$rule_count" -eq ${value.destinations.length * 2} || complete=0`,
    "    for destination in $(printf '%s' \"$expected_destinations\" | tr ',' ' '); do",
    "      iptables -C \"$chain\" -d \"$destination/32\" -p tcp --dport 443 -j REJECT --reject-with tcp-reset >/dev/null 2>&1 || complete=0",
    "      iptables -C \"$chain\" -d \"$destination/32\" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable >/dev/null 2>&1 || complete=0",
    "    done",
    "  fi",
    "  jump_count=$(iptables-save | awk -v chain=\"$chain\" '{ for (index = 1; index < NF; index += 1) if ($index == \"-j\" && $(index + 1) == chain) count += 1 } END { print count + 0 }')",
    "  test \"$jump_count\" -eq 1 || complete=0",
    "  iptables -C DOCKER-USER -s \"$marker_container_ip/32\" -m comment --comment \"$comment\" -j \"$chain\" >/dev/null 2>&1 || complete=0",
    "  if test \"$complete\" != 1; then echo PARTIAL; exit 0; fi",
    "  current_running=$(docker inspect bvm-egress --format '{{.State.Running}}' 2>/dev/null || true)",
    "  current_id=$(docker inspect bvm-egress --format '{{.Id}}' 2>/dev/null || true)",
    "  current_ips=$(docker inspect bvm-egress --format '{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{.IPAddress}} {{end}}{{end}}' 2>/dev/null || true)",
    "  set -- $current_ips",
    "  if test \"$current_running\" != true || test \"$#\" -ne 1 || test \"$current_id\" != \"$marker_container_id\" || test \"$1\" != \"$marker_container_ip\"; then echo CONTAINER_DRIFT; else echo FAULTED; fi",
    "  exit 0",
    "fi",
    "if iptables -S \"$chain\" >/dev/null 2>&1 || iptables-save | grep -Fq -- \"$comment\"; then exit 1; fi",
    "test -f \"$owner\" && test ! -L \"$owner\"",
    `test "$(jq -r '.event' "$owner")" = ${shellQuote(value.event)}`,
    `test "$(jq -r '.court' "$owner")" = ${shellQuote(String(value.camera))}`,
    `test "$(jq -r '.rendererGitSha' "$owner")" = ${shellQuote(value.rendererGitSha)}`,
    `test "$(jq -r '.rendererDeploymentId' "$owner")" = ${shellQuote(value.rendererDeploymentId)}`,
    `test "$(jq -r '.egressId' "$owner")" = ${shellQuote(value.egressId)}`,
    `test "$(jq -r '.destinationId' "$owner")" = ${shellQuote(value.destinationId)}`,
    `test "$(jq -r '.outputGeneration' "$owner")" = ${shellQuote(value.outputGeneration)}`,
    "current_running=$(docker inspect bvm-egress --format '{{.State.Running}}' 2>/dev/null || true)",
    "current_ips=$(docker inspect bvm-egress --format '{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{.IPAddress}} {{end}}{{end}}' 2>/dev/null || true)",
    "current_ipv6=$(docker inspect bvm-egress --format '{{range .NetworkSettings.Networks}}{{if .GlobalIPv6Address}}{{.GlobalIPv6Address}} {{end}}{{end}}' 2>/dev/null || true)",
    "set -- $current_ips",
    "if test \"$current_running\" = true && test \"$#\" -eq 1 && test -z \"$current_ipv6\"; then echo HEALTHY; else echo UNAVAILABLE; fi"
  ].join("\n");
}

export function injectCommand(target) {
  const value = validateTarget(target);
  const staticIdentity = markerStaticIdentity(value);
  const destinations = value.destinations.join(",");
  const comment = chainComment(value);
  return [
    "scorecheck_renderer_loss_inject=1",
    "set -eu",
    "cd /opt/compositor",
    `marker=${shellQuote(MARKER_PATH)}`,
    `chain=${shellQuote(value.chain)}`,
    `comment=${shellQuote(comment)}`,
    `expected_static=${shellQuote(staticIdentity)}`,
    `expected_destinations=${shellQuote(destinations)}`,
    `owner=${shellQuote(`requests/court-${value.camera}.owner.json`)}`,
    "test -f \"$owner\" && test ! -L \"$owner\"",
    `test "$(jq -r '.event' "$owner")" = ${shellQuote(value.event)}`,
    `test "$(jq -r '.court' "$owner")" = ${shellQuote(String(value.camera))}`,
    `test "$(jq -r '.rendererGitSha' "$owner")" = ${shellQuote(value.rendererGitSha)}`,
    `test "$(jq -r '.rendererDeploymentId' "$owner")" = ${shellQuote(value.rendererDeploymentId)}`,
    `test "$(jq -r '.egressId' "$owner")" = ${shellQuote(value.egressId)}`,
    `test "$(jq -r '.destinationId' "$owner")" = ${shellQuote(value.destinationId)}`,
    `test "$(jq -r '.outputGeneration' "$owner")" = ${shellQuote(value.outputGeneration)}`,
    "test \"$(docker inspect bvm-egress --format '{{.State.Running}}' 2>/dev/null || true)\" = true",
    "container_id=$(docker inspect bvm-egress --format '{{.Id}}')",
    "container_ips=$(docker inspect bvm-egress --format '{{range .NetworkSettings.Networks}}{{if .IPAddress}}{{.IPAddress}} {{end}}{{end}}')",
    "container_ipv6=$(docker inspect bvm-egress --format '{{range .NetworkSettings.Networks}}{{if .GlobalIPv6Address}}{{.GlobalIPv6Address}} {{end}}{{end}}')",
    "set -- $container_ips",
    "test \"$#\" -eq 1 && test -z \"$container_ipv6\"",
    "container_ip=$1",
    "if test -e \"$marker\"; then",
    "  test -f \"$marker\" && test ! -L \"$marker\"",
    "  IFS='|' read -r marker_static marker_container_id marker_container_ip marker_destinations < \"$marker\"",
    "  test \"$marker_static\" = \"$expected_static\" && test \"$marker_destinations\" = \"$expected_destinations\"",
    "  test \"$marker_container_id\" = \"$container_id\" && test \"$marker_container_ip\" = \"$container_ip\"",
    "else",
    "  ! iptables -S \"$chain\" >/dev/null 2>&1",
    "  ! iptables-save | grep -Fq -- \"$comment\"",
    "  umask 077",
    "  printf '%s|%s|%s|%s\\n' \"$expected_static\" \"$container_id\" \"$container_ip\" \"$expected_destinations\" > \"$marker\"",
    "fi",
    "iptables -S \"$chain\" >/dev/null 2>&1 || iptables -N \"$chain\"",
    "for destination in $(printf '%s' \"$expected_destinations\" | tr ',' ' '); do",
    "  iptables -C \"$chain\" -d \"$destination/32\" -p tcp --dport 443 -j REJECT --reject-with tcp-reset >/dev/null 2>&1 || iptables -A \"$chain\" -d \"$destination/32\" -p tcp --dport 443 -j REJECT --reject-with tcp-reset",
    "  iptables -C \"$chain\" -d \"$destination/32\" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable >/dev/null 2>&1 || iptables -A \"$chain\" -d \"$destination/32\" -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable",
    "done",
    "iptables -C DOCKER-USER -s \"$container_ip/32\" -m comment --comment \"$comment\" -j \"$chain\" >/dev/null 2>&1 || iptables -I DOCKER-USER 1 -s \"$container_ip/32\" -m comment --comment \"$comment\" -j \"$chain\""
  ].join("\n");
}

export function restoreCommand(target) {
  const value = validateTarget(target);
  const staticIdentity = markerStaticIdentity(value);
  const destinations = value.destinations.join(",");
  const comment = chainComment(value);
  return [
    "scorecheck_renderer_loss_restore=1",
    "set -eu",
    "cd /opt/compositor",
    `marker=${shellQuote(MARKER_PATH)}`,
    `chain=${shellQuote(value.chain)}`,
    `comment=${shellQuote(comment)}`,
    `expected_static=${shellQuote(staticIdentity)}`,
    `expected_destinations=${shellQuote(destinations)}`,
    "if test ! -e \"$marker\"; then ! iptables -S \"$chain\" >/dev/null 2>&1 && ! iptables-save | grep -Fq -- \"$comment\"; exit 0; fi",
    "test -f \"$marker\" && test ! -L \"$marker\"",
    "IFS='|' read -r marker_static marker_container_id marker_container_ip marker_destinations < \"$marker\"",
    "test \"$marker_static\" = \"$expected_static\" && test \"$marker_destinations\" = \"$expected_destinations\"",
    "while iptables -C DOCKER-USER -s \"$marker_container_ip/32\" -m comment --comment \"$comment\" -j \"$chain\" >/dev/null 2>&1; do iptables -D DOCKER-USER -s \"$marker_container_ip/32\" -m comment --comment \"$comment\" -j \"$chain\"; done",
    "! iptables-save | grep -Fq -- \"$comment\"",
    "if iptables -S \"$chain\" >/dev/null 2>&1; then reference_count=$(iptables-save | awk -v chain=\"$chain\" '{ for (index = 1; index < NF; index += 1) if ($index == \"-j\" && $(index + 1) == chain) count += 1 } END { print count + 0 }'); test \"$reference_count\" -eq 0; iptables -F \"$chain\"; iptables -X \"$chain\"; fi",
    "rm -f \"$marker\""
  ].join("\n");
}

export function validateTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) throw new Error("renderer-loss target schema is invalid");
  assertIpv4(value.host);
  if (typeof value.event !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{2,79}$/.test(value.event)) throw new Error("renderer-loss event is invalid");
  if (!Number.isInteger(value.camera) || value.camera < 1 || value.camera > 8) throw new Error("renderer-loss camera is invalid");
  if (typeof value.gateId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/.test(value.gateId)) throw new Error("renderer-loss gate id is invalid");
  const origin = new URL(value.origin);
  if (origin.protocol !== "https:" || !origin.hostname.endsWith(".vercel.app") || origin.origin !== value.origin) throw new Error("renderer-loss origin must be an immutable Vercel origin");
  if (!/^[a-f0-9]{40}$/.test(value.rendererGitSha ?? "")) throw new Error("renderer-loss renderer Git SHA is invalid");
  if (!/^dpl_[A-Za-z0-9]+$/.test(value.rendererDeploymentId ?? "")) throw new Error("renderer-loss renderer deployment id is invalid");
  if (!/^EG_[A-Za-z0-9]+$/.test(value.egressId ?? "")) throw new Error("renderer-loss Egress id is invalid");
  for (const [field, label] of [["destinationId", "destination id"], ["outputGeneration", "output generation"]]) {
    if (typeof value[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value[field])) throw new Error(`renderer-loss ${label} is invalid`);
  }
  const expectedChain = chainName(value.event, value.gateId, value.camera);
  if (value.chain !== expectedChain) throw new Error("renderer-loss chain is not identity-bound");
  const destinations = uniqueIpv4(value.destinations);
  if (destinations.length === 0 || destinations.length > 16 || JSON.stringify(destinations) !== JSON.stringify(value.destinations)) throw new Error("renderer-loss destinations must be unique sorted IPv4 addresses");
  if (value.resolvedAt !== undefined && !Number.isFinite(Date.parse(value.resolvedAt))) throw new Error("renderer-loss resolution time is invalid");
  return {
    schemaVersion: 1,
    host: value.host,
    event: value.event,
    camera: value.camera,
    gateId: value.gateId,
    origin: value.origin,
    rendererGitSha: value.rendererGitSha,
    rendererDeploymentId: value.rendererDeploymentId,
    egressId: value.egressId,
    destinationId: value.destinationId,
    outputGeneration: value.outputGeneration,
    chain: value.chain,
    destinations,
    ...(value.resolvedAt === undefined ? {} : { resolvedAt: value.resolvedAt })
  };
}

function markerStaticIdentity(target) {
  return [target.event, target.gateId, target.camera, target.origin, target.chain, target.rendererGitSha, target.rendererDeploymentId, target.egressId, target.destinationId, target.outputGeneration].join(":");
}

function chainName(event, gateId, camera) {
  return `SC_RL_${createHash("sha256").update(`${event}:${gateId}:${camera}`).digest("hex").slice(0, 10).toUpperCase()}`;
}

function chainComment(target) {
  return `scorecheck-renderer-loss-${target.chain.slice(-10).toLowerCase()}`;
}

function uniqueIpv4(values) {
  if (!Array.isArray(values)) throw new Error("renderer-loss DNS result is invalid");
  const output = [...new Set(values.map((value) => {
    assertIpv4(value);
    return value;
  }))].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  return output;
}

function requireConfirmation(actual, expected) {
  if (actual !== expected) throw new Error(`confirmation must be exactly ${expected}`);
}

function assertIpv4(value) {
  const parts = typeof value === "string" ? value.split(".").map(Number) : [];
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error("renderer-loss IPv4 address is invalid");
}

function protectedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}
