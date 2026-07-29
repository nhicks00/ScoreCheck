import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { parseEgressOwnership } from "./rehearsal/egress-runtime.mjs";
import { validateRendererBinding } from "./renderer-binding.mjs";
import { runCommand } from "./stack-deployer.mjs";

const MARKER_PATH = "/opt/compositor/.scorecheck-control-plane-loss-fault";
const NETWORK = "bvm-compositor_default";
const CONTAINERS = ["bvm-renderer", "bvm-egress"];

export class ControlPlaneLossFaultRuntime {
  constructor({ sshKey, knownHosts, runner = runCommand } = {}) {
    this.sshKey = protectedAbsolute(sshKey, "SSH private key");
    this.knownHosts = protectedAbsolute(knownHosts, "known_hosts path");
    if (typeof runner !== "function") throw new Error("control-plane-loss runner is invalid");
    this.runner = runner;
  }

  async plan({ host, event, camera, gateId, renderer, supabaseOrigin, egressOwner }) {
    const identity = validateIdentity({ host, event, camera, gateId, renderer, supabaseOrigin, egressOwner });
    const endpointInputs = [
      { role: "renderer", origin: identity.renderer.origin },
      { role: "supabase", origin: identity.supabaseOrigin }
    ];
    const discovered = parseDiscovery((await this.#ssh(identity.host, discoveryCommand(identity))).stdout);
    const endpoints = endpointInputs.map((endpoint) => ({
      ...endpoint,
      destinations: discovered.endpoints.find((entry) => entry.role === endpoint.role).destinations
    }));
    const target = validateTarget({
      schemaVersion: 1,
      ...identity,
      dockerSubnet: discovered.dockerSubnet,
      initialRendererContainerId: discovered.rendererContainerId,
      initialEgressContainerId: discovered.egressContainerId,
      chain: chainName(identity.event, identity.gateId, identity.camera),
      endpoints,
      resolvedAt: new Date().toISOString()
    });
    const status = await this.inspect(target);
    if (status.status !== "HEALTHY") throw new Error(`control-plane-loss preflight is ${status.status}`);
    const connectivity = await this.connectivity(target);
    if (!allReachable(connectivity)) throw new Error("control-plane-loss baseline provider connectivity is incomplete");
    return target;
  }

  async verifyDns(target) {
    const value = validateTarget(target);
    const currentResolution = parseResolution((await this.#ssh(value.host, resolutionCommand(value))).stdout);
    const endpoints = value.endpoints.map((endpoint) => {
      const current = currentResolution.find((entry) => entry.role === endpoint.role).destinations;
      return { role: endpoint.role, expected: endpoint.destinations, current, passed: JSON.stringify(current) === JSON.stringify(endpoint.destinations) };
    });
    return { checkedAt: new Date().toISOString(), passed: endpoints.every((entry) => entry.passed), endpoints };
  }

  async inspect(target) {
    const value = validateTarget(target);
    const status = (await this.#ssh(value.host, inspectCommand(value))).stdout.trim();
    if (!new Set(["HEALTHY", "FAULTED", "PARTIAL"]).has(status)) throw new Error("control-plane-loss fault status is invalid");
    return { status, checkedAt: new Date().toISOString() };
  }

  async connectivity(target) {
    const value = validateTarget(target);
    const raw = (await this.#ssh(value.host, connectivityCommand(value))).stdout.trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error("control-plane-loss connectivity response is invalid JSON"); }
    const expectedKeys = value.endpoints.flatMap((endpoint) => CONTAINERS.map((container) => `${container}:${endpoint.role}`)).sort();
    if (!parsed || parsed.schemaVersion !== 1 || JSON.stringify(Object.keys(parsed.results ?? {}).sort()) !== JSON.stringify(expectedKeys)
      || Object.values(parsed.results).some((entry) => typeof entry !== "boolean")) {
      throw new Error("control-plane-loss connectivity response is invalid");
    }
    return { checkedAt: new Date().toISOString(), results: parsed.results };
  }

  async inject({ target, confirmation }) {
    const value = validateTarget(target);
    requireConfirmation(confirmation, `FAULT-CONTROL-PLANE:${value.event}:CAMERA-${value.camera}`);
    const before = await this.inspect(value);
    if (before.status === "FAULTED") return { status: "FAULTED", adopted: true, injectedAt: null, connectivity: await this.connectivity(value) };
    if (before.status !== "HEALTHY") throw new Error(`control-plane dependencies cannot be faulted from ${before.status}`);
    try {
      await this.#ssh(value.host, injectCommand(value));
      const after = await this.inspect(value);
      if (after.status !== "FAULTED") throw new Error(`control-plane-loss fault did not converge: ${after.status}`);
      const connectivity = await this.connectivity(value);
      if (Object.values(connectivity.results).some(Boolean)) throw new Error("control-plane-loss fault did not deny every scoped provider path");
      return { status: "FAULTED", adopted: false, injectedAt: new Date().toISOString(), connectivity };
    } catch (error) {
      try { await this.#ssh(value.host, restoreCommand(value)); }
      catch (cleanupError) { throw new Error(`${safeError(error)}; automatic restoration also failed: ${safeError(cleanupError)}`); }
      throw error;
    }
  }

  async restore({ target, confirmation }) {
    const value = validateTarget(target);
    requireConfirmation(confirmation, `RESTORE-CONTROL-PLANE:${value.event}:CAMERA-${value.camera}`);
    const before = await this.inspect(value);
    if (before.status === "HEALTHY") return { status: "HEALTHY", adopted: true, restoredAt: null, connectivity: await this.connectivity(value) };
    await this.#ssh(value.host, restoreCommand(value));
    const after = await this.inspect(value);
    if (after.status !== "HEALTHY") throw new Error(`control-plane-loss restoration did not converge: ${after.status}`);
    return { status: "HEALTHY", adopted: false, restoredAt: new Date().toISOString(), connectivity: await this.connectivity(value) };
  }

  async recycleEgress({ target, confirmation }) {
    const value = validateTarget(target);
    requireConfirmation(confirmation, `RECYCLE-EGRESS:${value.event}:CAMERA-${value.camera}`);
    const status = await this.inspect(value);
    if (status.status !== "FAULTED") throw new Error(`Egress cannot be recycled while control-plane-loss status is ${status.status}`);
    const connectivity = await this.connectivity(value);
    if (Object.values(connectivity.results).some(Boolean)) throw new Error("Egress cannot be recycled while a scoped provider path remains reachable");
    await this.#ssh(value.host, recycleEgressCommand(value));
    return { status: "RECYCLE_REQUESTED", previousEgressId: value.egressOwner.egressId, previousContainerId: value.initialEgressContainerId, requestedAt: new Date().toISOString() };
  }

  #ssh(host, command) {
    assertIpv4(host);
    return this.runner("ssh", [
      "-i", this.sshKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}`,
      command
    ]);
  }
}

export function discoveryCommand(input) {
  const value = validateIdentity(input);
  return [
    "scorecheck_control_plane_loss_discovery=1",
    "set -eu",
    "cd /opt/compositor",
    `owner=${shellQuote(`requests/court-${value.camera}.owner.json`)}`,
    ownerAssertions(value),
    rendererAssertions(value),
    `network=${shellQuote(NETWORK)}`,
    "docker_subnets=$(docker network inspect \"$network\" --format '{{range .IPAM.Config}}{{if .Subnet}}{{.Subnet}} {{end}}{{end}}')",
    "set -- $docker_subnets",
    "test \"$#\" -eq 1",
    "docker_subnet=$1",
    "case \"$docker_subnet\" in *:*) exit 1;; esac",
    "renderer_id=$(docker inspect bvm-renderer --format '{{if .State.Running}}{{.Id}}{{end}}')",
    "egress_id=$(docker inspect bvm-egress --format '{{if .State.Running}}{{.Id}}{{end}}')",
    "test -n \"$renderer_id\" && test -n \"$egress_id\"",
    "for container in bvm-renderer bvm-egress; do",
    "  test \"$(docker inspect \"$container\" --format '{{range $name, $network := .NetworkSettings.Networks}}{{if eq $name \"bvm-compositor_default\"}}yes{{end}}{{end}}')\" = yes",
    "done",
    ...resolutionLines(value),
    ...connectivityAssertions(value, true),
    "jq -n --arg dockerSubnet \"$docker_subnet\" --arg rendererContainerId \"$renderer_id\" --arg egressContainerId \"$egress_id\" --arg rendererDestinations \"$renderer_destinations\" --arg supabaseDestinations \"$supabase_destinations\" '{schemaVersion:1,dockerSubnet:$dockerSubnet,rendererContainerId:$rendererContainerId,egressContainerId:$egressContainerId,endpoints:[{role:\"renderer\",destinations:($rendererDestinations|split(\" \")|map(select(length>0)))},{role:\"supabase\",destinations:($supabaseDestinations|split(\" \")|map(select(length>0)))}]}'"
  ].flat().join("\n");
}

export function resolutionCommand(input) {
  const value = validateIdentity(input);
  return [
    "scorecheck_control_plane_loss_resolution=1",
    "set -eu",
    "cd /opt/compositor",
    `owner=${shellQuote(`requests/court-${value.camera}.owner.json`)}`,
    ownerAssertions(value),
    rendererAssertions(value),
    ...resolutionLines(value),
    "jq -n --arg rendererDestinations \"$renderer_destinations\" --arg supabaseDestinations \"$supabase_destinations\" '{schemaVersion:1,endpoints:[{role:\"renderer\",destinations:($rendererDestinations|split(\" \")|map(select(length>0)))},{role:\"supabase\",destinations:($supabaseDestinations|split(\" \")|map(select(length>0)))}]}'"
  ].flat().join("\n");
}

export function inspectCommand(target) {
  const value = validateTarget(target);
  const digest = targetDigest(value);
  const destinations = allDestinations(value);
  const comment = chainComment(value);
  return [
    "scorecheck_control_plane_loss_inspect=1",
    "set -eu",
    `marker=${shellQuote(MARKER_PATH)}`,
    `chain=${shellQuote(value.chain)}`,
    `comment=${shellQuote(comment)}`,
    `expected_digest=${shellQuote(digest)}`,
    `expected_subnet=${shellQuote(value.dockerSubnet)}`,
    "if test ! -e \"$marker\"; then",
    "  if iptables -S \"$chain\" >/dev/null 2>&1 || iptables-save | grep -Fq -- \"$comment\"; then echo PARTIAL; else echo HEALTHY; fi",
    "  exit 0",
    "fi",
    "test -f \"$marker\" && test ! -L \"$marker\" || exit 1",
    "complete=1",
    "jq -e --arg digest \"$expected_digest\" --arg subnet \"$expected_subnet\" --arg chain \"$chain\" --arg comment \"$comment\" '.schemaVersion==1 and .targetSha256==$digest and .dockerSubnet==$subnet and .chain==$chain and .comment==$comment' \"$marker\" >/dev/null || complete=0",
    "iptables -S \"$chain\" >/dev/null 2>&1 || complete=0",
    "if test \"$complete\" = 1; then",
    "  rule_count=$(iptables -S \"$chain\" | awk '$1 == \"-A\" { count += 1 } END { print count + 0 }')",
    `  test "$rule_count" -eq ${destinations.length * 2} || complete=0`,
    ...destinations.flatMap((destination) => [
      `  iptables -C "$chain" -d ${shellQuote(`${destination}/32`)} -p tcp --dport 443 -j REJECT --reject-with tcp-reset >/dev/null 2>&1 || complete=0`,
      `  iptables -C "$chain" -d ${shellQuote(`${destination}/32`)} -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable >/dev/null 2>&1 || complete=0`
    ]),
    "fi",
    "jump_count=$(iptables-save | awk -v chain=\"$chain\" '{ for (field = 1; field < NF; field += 1) if ($field == \"-j\" && $(field + 1) == chain) count += 1 } END { print count + 0 }')",
    "test \"$jump_count\" -eq 1 || complete=0",
    "iptables -C DOCKER-USER -s \"$expected_subnet\" -m comment --comment \"$comment\" -j \"$chain\" >/dev/null 2>&1 || complete=0",
    "if test \"$complete\" = 1; then echo FAULTED; else echo PARTIAL; fi"
  ].join("\n");
}

export function connectivityCommand(target) {
  const value = validateTarget(target);
  const lines = ["scorecheck_control_plane_loss_connectivity=1", "set -eu", "results='{}'"];
  for (const endpoint of value.endpoints) {
    const rendererKey = `bvm-renderer:${endpoint.role}`;
    const egressKey = `bvm-egress:${endpoint.role}`;
    lines.push(
      `reachable=false; if docker exec bvm-renderer node -e ${shellQuote("fetch(process.argv[1], {signal: AbortSignal.timeout(3000)}).then(() => process.exit(0), () => process.exit(1))")} ${shellQuote(endpoint.origin)} >/dev/null 2>&1; then reachable=true; fi`,
      `results=$(printf '%s' "$results" | jq --arg key ${shellQuote(rendererKey)} --argjson reachable "$reachable" '. + {($key):$reachable}')`,
      `reachable=false; if docker exec bvm-egress curl -sS --connect-timeout 2 --max-time 3 -o /dev/null ${shellQuote(endpoint.origin)} >/dev/null 2>&1; then reachable=true; fi`,
      `results=$(printf '%s' "$results" | jq --arg key ${shellQuote(egressKey)} --argjson reachable "$reachable" '. + {($key):$reachable}')`
    );
  }
  lines.push("printf '%s' \"$results\" | jq '{schemaVersion:1,results:.}'");
  return lines.join("\n");
}

export function injectCommand(target) {
  const value = validateTarget(target);
  const digest = targetDigest(value);
  const comment = chainComment(value);
  return [
    "scorecheck_control_plane_loss_inject=1",
    "set -eu",
    "cd /opt/compositor",
    `marker=${shellQuote(MARKER_PATH)}`,
    `chain=${shellQuote(value.chain)}`,
    `comment=${shellQuote(comment)}`,
    `expected_digest=${shellQuote(digest)}`,
    `expected_subnet=${shellQuote(value.dockerSubnet)}`,
    `owner=${shellQuote(`requests/court-${value.camera}.owner.json`)}`,
    ownerAssertions(value),
    rendererAssertions(value),
    "docker_subnets=$(docker network inspect bvm-compositor_default --format '{{range .IPAM.Config}}{{if .Subnet}}{{.Subnet}} {{end}}{{end}}')",
    "test \"$docker_subnets\" = \"$expected_subnet \"",
    "if test -e \"$marker\"; then",
    "  test -f \"$marker\" && test ! -L \"$marker\"",
    "  jq -e --arg digest \"$expected_digest\" '.schemaVersion==1 and .targetSha256==$digest' \"$marker\" >/dev/null",
    "else",
    "  ! iptables -S \"$chain\" >/dev/null 2>&1",
    "  ! iptables-save | grep -Fq -- \"$comment\"",
    "  umask 077",
    "  jq -n --arg digest \"$expected_digest\" --arg subnet \"$expected_subnet\" --arg chain \"$chain\" --arg comment \"$comment\" '{schemaVersion:1,targetSha256:$digest,dockerSubnet:$subnet,chain:$chain,comment:$comment}' > \"$marker\"",
    "fi",
    "iptables -S \"$chain\" >/dev/null 2>&1 || iptables -N \"$chain\"",
    ...allDestinations(value).flatMap((destination) => [
      `iptables -C "$chain" -d ${shellQuote(`${destination}/32`)} -p tcp --dport 443 -j REJECT --reject-with tcp-reset >/dev/null 2>&1 || iptables -A "$chain" -d ${shellQuote(`${destination}/32`)} -p tcp --dport 443 -j REJECT --reject-with tcp-reset`,
      `iptables -C "$chain" -d ${shellQuote(`${destination}/32`)} -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable >/dev/null 2>&1 || iptables -A "$chain" -d ${shellQuote(`${destination}/32`)} -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable`
    ]),
    "iptables -C DOCKER-USER -s \"$expected_subnet\" -m comment --comment \"$comment\" -j \"$chain\" >/dev/null 2>&1 || iptables -I DOCKER-USER 1 -s \"$expected_subnet\" -m comment --comment \"$comment\" -j \"$chain\""
  ].flat().join("\n");
}

export function restoreCommand(target) {
  const value = validateTarget(target);
  const digest = targetDigest(value);
  const comment = chainComment(value);
  return [
    "scorecheck_control_plane_loss_restore=1",
    "set -eu",
    `marker=${shellQuote(MARKER_PATH)}`,
    `chain=${shellQuote(value.chain)}`,
    `comment=${shellQuote(comment)}`,
    `expected_digest=${shellQuote(digest)}`,
    `expected_subnet=${shellQuote(value.dockerSubnet)}`,
    "if test ! -e \"$marker\"; then ! iptables -S \"$chain\" >/dev/null 2>&1 && ! iptables-save | grep -Fq -- \"$comment\"; exit 0; fi",
    "test -f \"$marker\" && test ! -L \"$marker\"",
    "jq -e --arg digest \"$expected_digest\" '.schemaVersion==1 and .targetSha256==$digest' \"$marker\" >/dev/null",
    "while iptables -C DOCKER-USER -s \"$expected_subnet\" -m comment --comment \"$comment\" -j \"$chain\" >/dev/null 2>&1; do iptables -D DOCKER-USER -s \"$expected_subnet\" -m comment --comment \"$comment\" -j \"$chain\"; done",
    "! iptables-save | grep -Fq -- \"$comment\"",
    "if iptables -S \"$chain\" >/dev/null 2>&1; then reference_count=$(iptables-save | awk -v chain=\"$chain\" '{ for (field = 1; field < NF; field += 1) if ($field == \"-j\" && $(field + 1) == chain) count += 1 } END { print count + 0 }'); test \"$reference_count\" -eq 0; iptables -F \"$chain\"; iptables -X \"$chain\"; fi",
    "rm -f \"$marker\""
  ].join("\n");
}

export function recycleEgressCommand(target) {
  const value = validateTarget(target);
  return [
    "scorecheck_control_plane_loss_recycle_egress=1",
    "set -eu",
    "cd /opt/compositor",
    `marker=${shellQuote(MARKER_PATH)}`,
    `expected_digest=${shellQuote(targetDigest(value))}`,
    `owner=${shellQuote(`requests/court-${value.camera}.owner.json`)}`,
    "test -f \"$marker\" && test ! -L \"$marker\"",
    "jq -e --arg digest \"$expected_digest\" '.schemaVersion==1 and .targetSha256==$digest' \"$marker\" >/dev/null",
    ownerAssertions(value),
    `test "$(docker inspect bvm-egress --format '{{if .State.Running}}{{.Id}}{{end}}')" = ${shellQuote(value.initialEgressContainerId)}`,
    "docker rm -f bvm-egress >/dev/null"
  ].flat().join("\n");
}

export function validateTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) throw new Error("control-plane-loss target schema is invalid");
  const identity = validateIdentity(value);
  if (!isPrivateCidr(value.dockerSubnet)) throw new Error("control-plane-loss Docker subnet is invalid");
  for (const field of ["initialRendererContainerId", "initialEgressContainerId"]) {
    if (!/^[a-f0-9]{64}$/u.test(value[field] ?? "")) throw new Error(`control-plane-loss ${field} is invalid`);
  }
  const expectedChain = chainName(identity.event, identity.gateId, identity.camera);
  if (value.chain !== expectedChain) throw new Error("control-plane-loss chain is not identity-bound");
  if (!Array.isArray(value.endpoints) || value.endpoints.length !== 2 || value.endpoints[0]?.role !== "renderer" || value.endpoints[1]?.role !== "supabase") {
    throw new Error("control-plane-loss endpoints are invalid");
  }
  const endpoints = value.endpoints.map((endpoint) => {
    const expectedOrigin = endpoint.role === "renderer" ? identity.renderer.origin : identity.supabaseOrigin;
    if (endpoint.origin !== expectedOrigin) throw new Error(`control-plane-loss ${endpoint.role} origin changed`);
    const destinations = uniqueIpv4(endpoint.destinations);
    if (destinations.length === 0 || destinations.length > 16 || JSON.stringify(destinations) !== JSON.stringify(endpoint.destinations)) {
      throw new Error(`control-plane-loss ${endpoint.role} destinations must be unique sorted IPv4 addresses`);
    }
    return { role: endpoint.role, origin: endpoint.origin, destinations };
  });
  if (new Set(endpoints.flatMap((endpoint) => endpoint.destinations)).size !== endpoints.flatMap((endpoint) => endpoint.destinations).length) {
    throw new Error("control-plane-loss provider destinations overlap");
  }
  if (!Number.isFinite(Date.parse(value.resolvedAt ?? ""))) throw new Error("control-plane-loss resolution time is invalid");
  return {
    schemaVersion: 1,
    ...identity,
    dockerSubnet: value.dockerSubnet,
    initialRendererContainerId: value.initialRendererContainerId,
    initialEgressContainerId: value.initialEgressContainerId,
    chain: value.chain,
    endpoints,
    resolvedAt: value.resolvedAt
  };
}

function validateIdentity(value) {
  assertIpv4(value?.host);
  if (typeof value.event !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{2,79}$/u.test(value.event)) throw new Error("control-plane-loss event is invalid");
  if (!Number.isInteger(value.camera) || value.camera < 1 || value.camera > 8) throw new Error("control-plane-loss camera is invalid");
  if (typeof value.gateId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/u.test(value.gateId)) throw new Error("control-plane-loss gate id is invalid");
  const renderer = validateRendererBinding(value.renderer);
  const supabaseOrigin = validateSupabaseOrigin(value.supabaseOrigin);
  const egressOwner = parseEgressOwnership(JSON.stringify(value.egressOwner));
  if (egressOwner.event !== value.event || egressOwner.court !== value.camera
    || egressOwner.rendererGitSha !== renderer.gitSha || egressOwner.rendererDeploymentId !== renderer.deploymentId
    || egressOwner.rendererReleaseOrigin !== renderer.origin || egressOwner.rendererRuntimeOrigin !== "http://renderer:3000") {
    throw new Error("control-plane-loss Egress owner does not match the event-local renderer");
  }
  return { host: value.host, event: value.event, camera: value.camera, gateId: value.gateId, renderer, supabaseOrigin, egressOwner };
}

function ownerAssertions(value) {
  const owner = value.egressOwner;
  return [
    "test -f \"$owner\" && test ! -L \"$owner\"",
    `jq -e --arg event ${shellQuote(owner.event)} --argjson court ${shellQuote(String(owner.court))} --arg destinationId ${shellQuote(owner.destinationId)} --arg destinationRole ${shellQuote(owner.destinationRole)} --arg outputGeneration ${shellQuote(owner.outputGeneration)} --arg outputProfile ${shellQuote(owner.outputProfile)} --arg rendererGitSha ${shellQuote(owner.rendererGitSha)} --arg rendererDeploymentId ${shellQuote(owner.rendererDeploymentId)} --arg rendererRuntimeOrigin ${shellQuote(owner.rendererRuntimeOrigin)} --arg rendererReleaseOrigin ${shellQuote(owner.rendererReleaseOrigin)} --arg rendererBundleSha256 ${shellQuote(owner.rendererBundleSha256)} --arg requestSha256 ${shellQuote(owner.requestSha256)} --arg egressId ${shellQuote(owner.egressId)} '.schemaVersion==3 and .event==$event and .court==$court and .destinationId==$destinationId and .destinationRole==$destinationRole and .outputGeneration==$outputGeneration and .outputProfile==$outputProfile and .rendererGitSha==$rendererGitSha and .rendererDeploymentId==$rendererDeploymentId and .rendererRuntimeOrigin==$rendererRuntimeOrigin and .rendererReleaseOrigin==$rendererReleaseOrigin and .rendererBundleSha256==$rendererBundleSha256 and .requestSha256==$requestSha256 and .egressId==$egressId' "$owner" >/dev/null`
  ];
}

function rendererAssertions(value) {
  return [
    `curl -fsS --max-time 5 http://127.0.0.1:3000/api/program/renderer-binding | jq -e --arg origin ${shellQuote(value.renderer.origin)} --arg gitSha ${shellQuote(value.renderer.gitSha)} --arg deploymentId ${shellQuote(value.renderer.deploymentId)} '.schemaVersion==1 and .origin==$origin and .gitSha==$gitSha and .deploymentId==$deploymentId' >/dev/null`
  ];
}

function resolutionLines(value) {
  const rendererHostname = new URL(value.renderer.origin).hostname;
  const supabaseHostname = new URL(value.supabaseOrigin).hostname;
  return [
    `renderer_hostname=${shellQuote(rendererHostname)}`,
    `supabase_hostname=${shellQuote(supabaseHostname)}`,
    "renderer_destinations=$(docker exec bvm-renderer getent ahostsv4 \"$renderer_hostname\" | awk '{print $1}' | sort -u | tr '\\n' ' ')",
    "renderer_egress_destinations=$(docker exec bvm-egress getent ahostsv4 \"$renderer_hostname\" | awk '{print $1}' | sort -u | tr '\\n' ' ')",
    "supabase_destinations=$(docker exec bvm-renderer getent ahostsv4 \"$supabase_hostname\" | awk '{print $1}' | sort -u | tr '\\n' ' ')",
    "supabase_egress_destinations=$(docker exec bvm-egress getent ahostsv4 \"$supabase_hostname\" | awk '{print $1}' | sort -u | tr '\\n' ' ')",
    "test -n \"$renderer_destinations\" && test \"$renderer_destinations\" = \"$renderer_egress_destinations\"",
    "test -n \"$supabase_destinations\" && test \"$supabase_destinations\" = \"$supabase_egress_destinations\"",
    "set -- $renderer_destinations; test \"$#\" -ge 1 && test \"$#\" -le 16",
    "set -- $supabase_destinations; test \"$#\" -ge 1 && test \"$#\" -le 16"
  ];
}

function connectivityAssertions(value, expectedReachable) {
  const lines = [];
  for (const endpoint of [{ origin: value.renderer.origin }, { origin: value.supabaseOrigin }]) {
    const renderer = `docker exec bvm-renderer node -e ${shellQuote("fetch(process.argv[1], {signal: AbortSignal.timeout(3000)}).then(() => process.exit(0), () => process.exit(1))")} ${shellQuote(endpoint.origin)} >/dev/null 2>&1`;
    const egress = `docker exec bvm-egress curl -sS --connect-timeout 2 --max-time 3 -o /dev/null ${shellQuote(endpoint.origin)} >/dev/null 2>&1`;
    lines.push(expectedReachable ? renderer : `! ${renderer}`, expectedReachable ? egress : `! ${egress}`);
  }
  return lines;
}

function parseDiscovery(raw) {
  let value;
  try { value = JSON.parse(raw.trim()); } catch { throw new Error("control-plane-loss discovery response is invalid JSON"); }
  if (!value || value.schemaVersion !== 1 || !isPrivateCidr(value.dockerSubnet)
    || !/^[a-f0-9]{64}$/u.test(value.rendererContainerId ?? "") || !/^[a-f0-9]{64}$/u.test(value.egressContainerId ?? "")) {
    throw new Error("control-plane-loss discovery response is invalid");
  }
  return { ...value, endpoints: parseResolutionValue(value) };
}

function parseResolution(raw) {
  let value;
  try { value = JSON.parse(raw.trim()); } catch { throw new Error("control-plane-loss resolution response is invalid JSON"); }
  return parseResolutionValue(value);
}

function parseResolutionValue(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.endpoints) || value.endpoints.length !== 2
    || value.endpoints[0]?.role !== "renderer" || value.endpoints[1]?.role !== "supabase") {
    throw new Error("control-plane-loss resolution response is invalid");
  }
  return value.endpoints.map((entry) => {
    const destinations = uniqueIpv4(entry.destinations);
    if (destinations.length === 0 || destinations.length > 16) throw new Error(`control-plane-loss ${entry.role} origin must resolve to 1-16 IPv4 destinations`);
    return { role: entry.role, destinations };
  });
}

function validateSupabaseOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/^[a-z0-9-]+[.]supabase[.]co$/u.test(url.hostname) || url.origin !== value) {
    throw new Error("control-plane-loss Supabase origin is invalid");
  }
  return value;
}

function allReachable(value) { return Object.values(value.results).every(Boolean); }
function allDestinations(value) { return value.endpoints.flatMap((endpoint) => endpoint.destinations); }
function targetDigest(value) {
  return createHash("sha256").update(JSON.stringify({
    event: value.event,
    camera: value.camera,
    gateId: value.gateId,
    renderer: value.renderer,
    supabaseOrigin: value.supabaseOrigin,
    egressOwner: value.egressOwner,
    dockerSubnet: value.dockerSubnet,
    chain: value.chain,
    endpoints: value.endpoints
  })).digest("hex");
}
function chainName(event, gateId, camera) { return `SC_CP_${createHash("sha256").update(`${event}:${gateId}:${camera}`).digest("hex").slice(0, 10).toUpperCase()}`; }
function chainComment(target) { return `scorecheck-control-plane-loss-${target.chain.slice(-10).toLowerCase()}`; }

function uniqueIpv4(values) {
  if (!Array.isArray(values)) throw new Error("control-plane-loss DNS result is invalid");
  return [...new Set(values.map((value) => { assertIpv4(value); return value; }))].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}
function isPrivateCidr(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u.exec(value ?? "");
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255) || prefix < 16 || prefix > 28) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}
function requireConfirmation(actual, expected) { if (actual !== expected) throw new Error(`confirmation must be exactly ${expected}`); }
function assertIpv4(value) {
  const parts = typeof value === "string" ? value.split(".").map(Number) : [];
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) throw new Error("control-plane-loss IPv4 address is invalid");
}
function protectedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}
function shellQuote(value) { return `'${String(value).replaceAll("'", `'"'"'`)}'`; }
function safeError(error) { return (error instanceof Error ? error.message : String(error)).replace(/[\r\n\0]+/gu, " ").slice(0, 320); }
