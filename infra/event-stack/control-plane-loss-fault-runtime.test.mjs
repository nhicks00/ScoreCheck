import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  connectivityCommand,
  ControlPlaneLossFaultRuntime,
  discoveryCommand,
  injectCommand,
  inspectCommand,
  recycleEgressCommand,
  restoreCommand,
  validateTarget
} from "./control-plane-loss-fault-runtime.mjs";

const renderer = {
  schemaVersion: 1,
  provider: "vercel",
  origin: "https://scorecheck-test-abc123.vercel.app",
  deploymentId: "dpl_renderer123",
  gitSha: "a".repeat(40),
  assetNamespace: "dpl_renderer123",
  contracts: {
    programSession: "program-session-v1",
    overlayState: "overlay-state-v1",
    commentary: "commentary-v1",
    browserHeartbeat: "browser-heartbeat-v6"
  }
};
const owner = {
  schemaVersion: 3,
  event: "control-plane-event",
  court: 5,
  destinationId: "broadcast-5",
  destinationRole: "primary",
  outputGeneration: "generation-1234",
  outputProfile: "1080p30",
  rendererGitSha: renderer.gitSha,
  rendererDeploymentId: renderer.deploymentId,
  rendererRuntimeOrigin: "http://renderer:3000",
  rendererReleaseOrigin: renderer.origin,
  rendererBundleSha256: "b".repeat(64),
  egressId: "EG_initial123",
  requestSha256: "c".repeat(64),
  startedAt: "2026-07-29T10:00:00Z"
};

test("control-plane fault scopes provider denial to one compositor Docker subnet and restores exactly", async () => {
  let status = "HEALTHY";
  const commands = [];
  const runtime = new ControlPlaneLossFaultRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known_hosts",
    resolver: async (hostname) => hostname.endsWith("supabase.co") ? ["203.0.113.20"] : ["203.0.113.10"],
    runner: async (_command, args) => {
      const remote = args.at(-1);
      commands.push(remote);
      if (remote.includes("scorecheck_control_plane_loss_discovery=1")) return { stdout: `${JSON.stringify(discovery())}\n`, stderr: "" };
      if (remote.includes("scorecheck_control_plane_loss_inspect=1")) return { stdout: `${status}\n`, stderr: "" };
      if (remote.includes("scorecheck_control_plane_loss_connectivity=1")) return { stdout: `${JSON.stringify(connectivity(status === "HEALTHY"))}\n`, stderr: "" };
      if (remote.includes("scorecheck_control_plane_loss_inject=1")) status = "FAULTED";
      if (remote.includes("scorecheck_control_plane_loss_restore=1")) status = "HEALTHY";
      return { stdout: "", stderr: "" };
    }
  });
  const target = await runtime.plan(planInput());
  assert.equal(target.dockerSubnet, "172.18.0.0/16");
  const fault = await runtime.inject({ target, confirmation: "FAULT-CONTROL-PLANE:control-plane-event:CAMERA-5" });
  assert.equal(fault.status, "FAULTED");
  assert.ok(Object.values(fault.connectivity.results).every((value) => value === false));
  const recycle = await runtime.recycleEgress({ target, confirmation: "RECYCLE-EGRESS:control-plane-event:CAMERA-5" });
  assert.equal(recycle.previousEgressId, owner.egressId);
  const restored = await runtime.restore({ target, confirmation: "RESTORE-CONTROL-PLANE:control-plane-event:CAMERA-5" });
  assert.equal(restored.status, "HEALTHY");
  assert.ok(Object.values(restored.connectivity.results).every(Boolean));

  const injected = commands.find((command) => command.includes("scorecheck_control_plane_loss_inject=1"));
  assert.match(injected, /iptables -I DOCKER-USER 1 -s "\$expected_subnet"/u);
  assert.doesNotMatch(injected, /iptables -[AI] (?:OUTPUT|FORWARD)/u);
  assert.ok(commands.some((command) => command.includes("scorecheck_control_plane_loss_connectivity=1") && command.includes("bvm-renderer")));
  assert.ok(commands.some((command) => command.includes("scorecheck_control_plane_loss_recycle_egress=1") && command.includes(owner.egressId)));
  assert.ok(commands.some((command) => command.includes("iptables -X \"$chain\"")));
  await assert.rejects(() => runtime.inject({ target, confirmation: "yes" }), /confirmation must be exactly/u);
});

test("control-plane fault cleans a partial injection before returning failure", async () => {
  let status = "HEALTHY";
  let restored = 0;
  const runtime = new ControlPlaneLossFaultRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known_hosts",
    resolver: async (hostname) => hostname.endsWith("supabase.co") ? ["203.0.113.20"] : ["203.0.113.10"],
    runner: async (_command, args) => {
      const remote = args.at(-1);
      if (remote.includes("scorecheck_control_plane_loss_discovery=1")) return { stdout: JSON.stringify(discovery()), stderr: "" };
      if (remote.includes("scorecheck_control_plane_loss_inspect=1")) return { stdout: `${status}\n`, stderr: "" };
      if (remote.includes("scorecheck_control_plane_loss_connectivity=1")) return { stdout: JSON.stringify(connectivity(true)), stderr: "" };
      if (remote.includes("scorecheck_control_plane_loss_inject=1")) { status = "PARTIAL"; throw new Error("simulated SSH loss"); }
      if (remote.includes("scorecheck_control_plane_loss_restore=1")) { status = "HEALTHY"; restored += 1; }
      return { stdout: "", stderr: "" };
    }
  });
  const target = await runtime.plan(planInput());
  await assert.rejects(
    () => runtime.inject({ target, confirmation: "FAULT-CONTROL-PLANE:control-plane-event:CAMERA-5" }),
    /simulated SSH loss/u
  );
  assert.equal(restored, 1);
});

test("control-plane target rejects broad networks, owner drift, duplicate provider destinations, and DNS drift", async () => {
  const runtime = runtimeForPlan();
  const target = await runtime.plan(planInput());
  assert.equal(validateTarget(target).camera, 5);
  assert.throws(() => validateTarget({ ...target, dockerSubnet: "0.0.0.0/0" }), /Docker subnet/u);
  assert.throws(() => validateTarget({ ...target, egressOwner: { ...owner, event: "other-event" } }), /does not match/u);
  assert.throws(() => validateTarget({
    ...target,
    endpoints: target.endpoints.map((entry) => ({ ...entry, destinations: ["203.0.113.10"] }))
  }), /destinations overlap/u);
  const changed = new ControlPlaneLossFaultRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known_hosts",
    resolver: async (hostname) => hostname.endsWith("supabase.co") ? ["203.0.113.21"] : ["203.0.113.11"]
  });
  assert.equal((await changed.verifyDns(target)).passed, false);
});

test("control-plane remote programs are valid POSIX shell", async () => {
  const target = await runtimeForPlan().plan(planInput());
  for (const command of [discoveryCommand(planInput()), inspectCommand(target), connectivityCommand(target), injectCommand(target), recycleEgressCommand(target), restoreCommand(target)]) {
    const result = spawnSync("sh", ["-n"], { input: command, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("control-plane iptables reference counters execute with the host awk", async () => {
  const target = await runtimeForPlan().plan(planInput());
  for (const command of [inspectCommand(target), restoreCommand(target)]) {
    const programs = [...command.matchAll(/awk -v chain="\$chain" '([^']+)'/gu)].map((match) => match[1]);
    assert.ok(programs.length > 0);
    for (const program of programs) {
      const result = spawnSync("awk", ["-v", "chain=SC_TEST", program], {
        input: "-A DOCKER-USER -j SC_TEST\n-A SC_TEST -d 203.0.113.10/32 -j REJECT\n",
        encoding: "utf8"
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "1");
    }
  }
});

function runtimeForPlan() {
  return new ControlPlaneLossFaultRuntime({
    sshKey: "/tmp/key",
    knownHosts: "/tmp/known_hosts",
    resolver: async (hostname) => hostname.endsWith("supabase.co") ? ["203.0.113.20"] : ["203.0.113.10"],
    runner: async (_command, args) => {
      const remote = args.at(-1);
      if (remote.includes("scorecheck_control_plane_loss_discovery=1")) return { stdout: JSON.stringify(discovery()), stderr: "" };
      if (remote.includes("scorecheck_control_plane_loss_inspect=1")) return { stdout: "HEALTHY\n", stderr: "" };
      if (remote.includes("scorecheck_control_plane_loss_connectivity=1")) return { stdout: JSON.stringify(connectivity(true)), stderr: "" };
      return { stdout: "", stderr: "" };
    }
  });
}

function planInput() {
  return {
    host: "198.51.100.10",
    event: owner.event,
    camera: owner.court,
    gateId: "control-plane-12345678",
    renderer,
    supabaseOrigin: "https://project-test.supabase.co",
    egressOwner: owner
  };
}

function discovery() {
  return {
    schemaVersion: 1,
    dockerSubnet: "172.18.0.0/16",
    rendererContainerId: "d".repeat(64),
    egressContainerId: "e".repeat(64)
  };
}

function connectivity(reachable) {
  return {
    schemaVersion: 1,
    results: {
      "bvm-renderer:renderer": reachable,
      "bvm-egress:renderer": reachable,
      "bvm-renderer:supabase": reachable,
      "bvm-egress:supabase": reachable
    }
  };
}
