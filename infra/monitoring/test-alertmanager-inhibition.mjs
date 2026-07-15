#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const baseUrl = process.env.ALERTMANAGER_TEST_URL?.replace(/\/+$/, "") || "http://127.0.0.1:9093";
const gateId = `gate-${randomUUID()}`;
const startsAt = new Date(Date.now() - 1_000).toISOString();
const endsAt = new Date(Date.now() + 120_000).toISOString();

await waitForReady();

const alerts = [
  alert("raw-source", "ScoreCheckRequiredRawPathMissing", { court: "1" }),
  alert("raw-target", "ScoreCheckProgramBrowserMissing", { court: "1" }),
  alert("raw-egress-target", "ScoreCheckEgressOutputMissing", { agent: "compositor-z", court: "1" }),
  alert("raw-peer", "ScoreCheckProgramBrowserMissing", { court: "2" }),
  alert("commentary-source", "ScoreCheckCommentaryDisconnected", { court: "3" }),
  alert("commentary-target", "ScoreCheckCommentaryTrackMissing", { court: "3" }),
  alert("commentary-peer", "ScoreCheckCommentaryTrackMissing", { court: "4" }),
  alert("agent-source", "ScoreCheckAgentMissing", { agent: "compositor-a" }),
  alert("agent-target", "ScoreCheckServiceNotRunning", { agent: "compositor-a", service: "egress" }),
  alert("agent-egress-output-target", "ScoreCheckEgressOutputMissing", { agent: "compositor-a", court: "1" }),
  alert("agent-egress-capacity-target", "ScoreCheckEgressExpectationExceedsCapacity", { agent: "compositor-a" }),
  alert("agent-peer", "ScoreCheckServiceNotRunning", { agent: "compositor-b", service: "egress" }),
  alert("egress-source", "ScoreCheckEgressWorkerUnavailable", { agent: "compositor-c" }),
  alert("egress-target", "ScoreCheckEgressOutputMissing", { agent: "compositor-c", court: "5" }),
  alert("egress-capacity-target", "ScoreCheckEgressExpectationExceedsCapacity", { agent: "compositor-c" }),
  alert("capacity-source", "ScoreCheckEgressExpectationExceedsCapacity", { agent: "compositor-f" }),
  alert("capacity-output-target", "ScoreCheckEgressOutputMissing", { agent: "compositor-f", court: "4" }),
  alert("egress-output-source", "ScoreCheckEgressOutputMissing", { agent: "compositor-e", court: "8" }),
  alert("egress-browser-target", "ScoreCheckProgramBrowserMissing", { agent: "compositor-e", court: "8" }),
  alert("egress-peer", "ScoreCheckEgressOutputMissing", { agent: "compositor-d", court: "7" }),
  alert("program-source", "ScoreCheckProgramBranchProgressMissing", { court: "6" }),
  alert("program-egress-target", "ScoreCheckEgressOutputMissing", { agent: "compositor-y", court: "6" }),
  alert("score-source", "ScoreCheckScoreWorkerUnavailable"),
  alert("score-target", "ScoreCheckSourceAlignmentFailed", { court: "7" }),
  alert("youtube-source", "ScoreCheckYouTubeUnhealthy", { court: "5" }),
  alert("youtube-target", "ScoreCheckYouTubeDegraded", { court: "5" }),
  alert("youtube-peer", "ScoreCheckYouTubeDegraded", { court: "7" })
];

const accepted = await fetch(`${baseUrl}/api/v2/alerts`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(alerts)
});
if (!accepted.ok) throw new Error(`Alertmanager rejected inhibition fixtures with HTTP ${accepted.status}.`);

const expected = new Map([
  ["raw-source", "active"],
  ["raw-target", "suppressed"],
  ["raw-egress-target", "suppressed"],
  ["raw-peer", "active"],
  ["commentary-source", "active"],
  ["commentary-target", "suppressed"],
  ["commentary-peer", "active"],
  ["agent-source", "active"],
  ["agent-target", "suppressed"],
  ["agent-egress-output-target", "suppressed"],
  ["agent-egress-capacity-target", "suppressed"],
  ["agent-peer", "active"],
  ["egress-source", "active"],
  ["egress-target", "suppressed"],
  ["egress-capacity-target", "suppressed"],
  ["capacity-source", "active"],
  ["capacity-output-target", "suppressed"],
  ["egress-output-source", "active"],
  ["egress-browser-target", "suppressed"],
  ["egress-peer", "active"],
  ["program-source", "active"],
  ["program-egress-target", "suppressed"],
  ["score-source", "active"],
  ["score-target", "suppressed"],
  ["youtube-source", "active"],
  ["youtube-target", "suppressed"],
  ["youtube-peer", "active"]
]);

let latest = new Map();
for (let attempt = 0; attempt < 20; attempt += 1) {
  await sleep(250);
  const response = await fetch(`${baseUrl}/api/v2/alerts`);
  if (!response.ok) continue;
  const body = await response.json();
  latest = new Map(body
    .filter((entry) => entry?.labels?.gate_id === gateId)
    .map((entry) => [entry.labels.gate_case, entry.status?.state]));
  if ([...expected].every(([name, state]) => latest.get(name) === state)) {
    console.log(`Alertmanager inhibition gate passed (${expected.size} fixtures).`);
    process.exit(0);
  }
}

const mismatches = [...expected]
  .filter(([name, state]) => latest.get(name) !== state)
  .map(([name, state]) => `${name}: expected ${state}, observed ${latest.get(name) ?? "missing"}`);
throw new Error(`Alertmanager inhibition gate failed: ${mismatches.join("; ")}`);

function alert(gateCase, alertname, labels = {}) {
  return {
    labels: { alertname, gate_id: gateId, gate_case: gateCase, ...labels },
    annotations: { summary: "ScoreCheck deployment inhibition fixture." },
    startsAt,
    endsAt,
    generatorURL: "https://monitor.invalid/preflight"
  };
}

async function waitForReady() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/-/ready`);
      if (response.ok) return;
    } catch {
      // The disposable process may still be binding its API socket.
    }
    await sleep(250);
  }
  throw new Error("Disposable Alertmanager did not become ready.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
