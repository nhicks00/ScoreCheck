#!/usr/bin/env node

import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_DURATION_SECONDS = 120;

export function summarizeSnapshot(snapshot, courtNumber, timing) {
  const court = snapshot?.courts?.find((entry) => entry.courtNumber === courtNumber);
  if (!court) throw new Error(`Camera ${courtNumber} is missing from the monitoring snapshot.`);
  const receivedAtMs = Date.parse(timing.receivedAt);
  const generatedAtMs = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(receivedAtMs) || !Number.isFinite(generatedAtMs)) {
    throw new Error("Monitoring snapshot timestamps are invalid.");
  }
  return {
    kind: "sample",
    sequence: timing.sequence,
    requestedAt: timing.requestedAt,
    receivedAt: timing.receivedAt,
    requestLatencyMs: timing.requestLatencyMs,
    snapshotGeneratedAt: snapshot.generatedAt,
    snapshotAgeMs: Math.max(0, receivedAtMs - generatedAtMs),
    collector: snapshot.collector,
    event: snapshot.event ? { id: snapshot.event.id, status: snapshot.event.status } : null,
    notifications: snapshot.notifications,
    deadMan: snapshot.deadMan,
    faultGates: snapshot.faultGates,
    court,
    peerCourts: snapshot.courts
      .filter((entry) => entry.courtNumber !== courtNumber)
      .map((entry) => ({ courtNumber: entry.courtNumber, overallState: entry.overallState })),
    incidents: snapshot.incidents.filter((incident) => incident.status !== "resolved"),
    agents: snapshot.agents.map((agent) => ({
      agentId: agent.agentId,
      role: agent.role,
      assignedCourts: agent.assignedCourts,
      state: agent.state,
      ageMs: agent.ageMs,
      egress: agent.nativeServices?.egress ?? null
    }))
  };
}

export function evaluateEvidence(rows, options) {
  const samples = rows.filter((row) => row.kind === "sample");
  const errors = rows.filter((row) => row.kind === "error");
  if (samples.length === 0) {
    return verdict("INVALID", options, { errors: errors.length, reason: "No valid monitoring samples were captured." });
  }
  const baseline = samples[0];
  const baselineIncidentIds = new Set(baseline.incidents.map((incident) => incident.id));
  const baselinePeerStates = new Map(baseline.peerCourts.map((court) => [court.courtNumber, court.overallState]));
  const issueSamples = options.expectedIssue
    ? samples.filter((sample) => sampleHasIssue(sample, options.expectedIssue))
    : [];
  const firstIssue = issueSamples[0] ?? null;
  const lastIssue = issueSamples.at(-1) ?? null;
  const recovery = lastIssue && options.requireRecovery
    ? samples.find((sample) => Date.parse(sample.receivedAt) > Date.parse(lastIssue.receivedAt) && !sampleHasIssue(sample, options.expectedIssue)) ?? null
    : null;
  const unexpectedIncidents = new Map();
  const unexpectedPeerStates = new Map();
  const allowedPeers = new Set(options.allowedPeerCourts ?? []);

  for (const sample of samples) {
    for (const incident of sample.incidents) {
      if (baselineIncidentIds.has(incident.id)) continue;
      const expectedIncident = Boolean(options.expectedIssue)
        && incident.issueCode === options.expectedIssue
        && (incident.courtNumber === options.courtNumber
          || incident.courtNumber === null
          || allowedPeers.has(incident.courtNumber));
      if (expectedIncident) continue;
      unexpectedIncidents.set(incident.id, { id: incident.id, courtNumber: incident.courtNumber, issueCode: incident.issueCode });
    }
    for (const peer of sample.peerCourts) {
      if (allowedPeers.has(peer.courtNumber)) continue;
      const baselineState = baselinePeerStates.get(peer.courtNumber);
      if (!attentionState(peer.overallState) || attentionState(baselineState)) continue;
      unexpectedPeerStates.set(peer.courtNumber, { courtNumber: peer.courtNumber, baselineState, observedState: peer.overallState });
    }
  }

  const generatedTimes = samples.map((sample) => Date.parse(sample.snapshotGeneratedAt));
  const maxGeneratedGapMs = maximumGap(generatedTimes);
  const staleSnapshotSamples = samples.filter((sample) => sample.snapshotAgeMs > options.maxSnapshotAgeMs).length;
  const collectorFailures = samples.filter((sample) => (
    sample.collector.state !== "HEALTHY"
      || sample.collector.agentsFresh !== sample.collector.agentsExpected
  )).length;
  const notificationFailures = samples.filter((sample) => sample.notifications?.state !== "HEALTHY").length;
  const deadManFailures = samples.filter((sample) => sample.deadMan?.state !== "HEALTHY").length;
  const baselineProblems = faultReadyBaselineProblems(baseline, options);
  const baselineClean = baselineProblems.length === 0;
  let status = "PASS";
  let reason = "Expected issue and isolation evidence were captured.";
  if (!baselineClean) {
    status = "INVALID";
    reason = `The first sample was not fault-ready: ${baselineProblems.join("; ")}`;
  } else if (collectorFailures > 0 || notificationFailures > 0 || deadManFailures > 0 || staleSnapshotSamples > 0 || errors.length > 0) {
    status = "INVALID";
    reason = "Monitoring collection was not continuously healthy.";
  } else if (options.expectedIssue && !firstIssue) {
    status = "FAIL";
    reason = `Expected issue ${options.expectedIssue} was not observed.`;
  } else if (options.expectedIssue && options.requireRecovery && !recovery) {
    status = "FAIL";
    reason = `Expected issue ${options.expectedIssue} did not recover inside the capture window.`;
  } else if (unexpectedIncidents.size > 0 || unexpectedPeerStates.size > 0) {
    status = "FAIL";
    reason = "An unapproved incident or peer-camera impact occurred during the selected-camera fault.";
  } else if (!options.expectedIssue) {
    status = "CAPTURED";
    reason = "Baseline evidence was captured without an expected issue assertion.";
  }

  return verdict(status, options, {
    reason,
    sampleCount: samples.length,
    errorCount: errors.length,
    firstSampleAt: samples[0].receivedAt,
    lastSampleAt: samples.at(-1).receivedAt,
    maxSnapshotGeneratedGapMs: maxGeneratedGapMs,
    maxAllowedSnapshotAgeMs: options.maxSnapshotAgeMs,
    staleSnapshotSamples,
    collectorFailureSamples: collectorFailures,
    notificationFailureSamples: notificationFailures,
    deadManFailureSamples: deadManFailures,
    baselineClean,
    baselineProblems,
    firstIssueAt: firstIssue?.receivedAt ?? null,
    lastIssueAt: lastIssue?.receivedAt ?? null,
    recoveredAt: recovery?.receivedAt ?? null,
    unexpectedIncidents: [...unexpectedIncidents.values()],
    unexpectedPeerStates: [...unexpectedPeerStates.values()],
    pathTransitions: pathTransitions(samples),
    browserTransitions: browserTransitions(samples)
  });
}

export async function captureEvidence(options, dependencies = {}) {
  const fetchSnapshot = dependencies.fetchSnapshot ?? (() => loadSnapshot(options.apiBase, options.token));
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const now = dependencies.now ?? (() => Date.now());
  const rows = [];
  const startedAtMs = now();
  const deadlineMs = startedAtMs + options.durationSeconds * 1_000;
  const file = await openProtectedOutput(options.output);
  try {
    await writeRow(file, {
      kind: "header",
      schemaVersion: 1,
      startedAt: new Date(startedAtMs).toISOString(),
      courtNumber: options.courtNumber,
      expectedIssue: options.expectedIssue,
      requireRecovery: options.requireRecovery,
      allowedPeerCourts: options.allowedPeerCourts,
      intervalMs: options.intervalMs,
      maxSnapshotAgeMs: options.maxSnapshotAgeMs,
      durationSeconds: options.durationSeconds
    });
    let sequence = 0;
    while (true) {
      const dueAt = startedAtMs + sequence * options.intervalMs;
      const waitMs = dueAt - now();
      if (waitMs > 0) await sleep(waitMs);
      if (now() > deadlineMs && sequence > 0) break;
      const requestedAtMs = now();
      try {
        const snapshot = await fetchSnapshot();
        const receivedAtMs = now();
        const row = summarizeSnapshot(snapshot, options.courtNumber, {
          sequence,
          requestedAt: new Date(requestedAtMs).toISOString(),
          receivedAt: new Date(receivedAtMs).toISOString(),
          requestLatencyMs: Math.max(0, receivedAtMs - requestedAtMs)
        });
        rows.push(row);
        await writeRow(file, row);
        if (sequence === 0) {
          const problems = faultReadyBaselineProblems(row, options);
          const state = problems.length === 0 ? "READY" : "INVALID";
          const reason = problems.length === 0 ? "" : ` reason=${problems.join("; ")}`;
          process.stderr.write(`BASELINE ${state} camera=${options.courtNumber} at=${row.receivedAt}${reason}\n`);
        }
      } catch (error) {
        const row = {
          kind: "error",
          sequence,
          observedAt: new Date(now()).toISOString(),
          code: operationalErrorCode(error)
        };
        rows.push(row);
        await writeRow(file, row);
      }
      sequence += 1;
    }
    const summary = evaluateEvidence(rows, options);
    await writeRow(file, { kind: "summary", completedAt: new Date(now()).toISOString(), ...summary });
    return summary;
  } finally {
    await file.close();
  }
}

async function openProtectedOutput(output) {
  if (!isAbsolute(output)) throw new Error("Evidence output must be an absolute path.");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  return open(output, "wx", 0o600);
}

async function writeRow(file, row) {
  await file.write(`${JSON.stringify(row)}\n`);
}

async function loadSnapshot(apiBase, token) {
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/v1/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Monitor API returned HTTP ${response.status}.`);
  return response.json();
}

function parseArgs(argv) {
  const options = {
    courtNumber: null,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxSnapshotAgeMs: 15_000,
    expectedIssue: null,
    requireRecovery: false,
    allowedPeerCourts: [],
    output: null,
    apiBase: process.env.MONITOR_API_BASE?.trim() || "https://monitor.beachvolleyballmedia.com"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--court") options.courtNumber = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--duration-seconds") options.durationSeconds = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--interval-ms") options.intervalMs = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--max-snapshot-age-ms") options.maxSnapshotAgeMs = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--expected-issue") options.expectedIssue = requiredValue(argv, ++index, argument);
    else if (argument === "--require-recovery") options.requireRecovery = true;
    else if (argument === "--allowed-peer-courts") options.allowedPeerCourts = parseCourtList(requiredValue(argv, ++index, argument));
    else if (argument === "--output") options.output = requiredValue(argv, ++index, argument);
    else if (argument === "--api-base") options.apiBase = requiredValue(argv, ++index, argument);
    else if (argument === "--help" || argument === "-h") return null;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  integerRange(options.courtNumber, "court", 1, 8);
  integerRange(options.durationSeconds, "duration seconds", 5, 1_800);
  integerRange(options.intervalMs, "interval milliseconds", 500, 5_000);
  integerRange(options.maxSnapshotAgeMs, "maximum snapshot age milliseconds", 5_000, 60_000);
  if (!options.output) throw new Error("--output is required.");
  if (options.expectedIssue && !/^[A-Z0-9_]{3,100}$/.test(options.expectedIssue)) throw new Error("Invalid expected issue code.");
  if (options.requireRecovery && !options.expectedIssue) throw new Error("--require-recovery requires --expected-issue.");
  const parsedBase = new URL(options.apiBase);
  if (parsedBase.protocol !== "https:" && parsedBase.hostname !== "127.0.0.1" && parsedBase.hostname !== "localhost") {
    throw new Error("Monitor API must use HTTPS unless it is local.");
  }
  return options;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseCourtList(value) {
  if (!value) return [];
  const courts = value.split(",").map(Number);
  for (const court of courts) integerRange(court, "allowed peer court", 1, 8);
  if (new Set(courts).size !== courts.length) throw new Error("Allowed peer courts must be unique.");
  return courts;
}

function integerRange(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
}

function sampleHasIssue(sample, expectedIssue) {
  return sample.court.stages.some((stage) => stage.issueCode === expectedIssue)
    || sample.incidents.some((incident) => incident.issueCode === expectedIssue && (
      incident.courtNumber === sample.court.courtNumber
    ));
}

function attentionState(state) {
  return state === "CRITICAL" || state === "DEGRADED" || state === "UNKNOWN";
}

function faultReadyBaselineProblems(sample, options) {
  const problems = [];
  if (sample.incidents.length > 0) problems.push("active incidents exist");
  if (sample.collector.state !== "HEALTHY" || sample.collector.agentsFresh !== sample.collector.agentsExpected) {
    problems.push("collector is unhealthy");
  }
  if (sample.notifications?.state !== "HEALTHY") problems.push("notification delivery is unhealthy");
  if (sample.deadMan?.state !== "HEALTHY") problems.push("dead-man monitoring is unhealthy");
  if (sample.snapshotAgeMs > options.maxSnapshotAgeMs) problems.push("snapshot is stale");
  if (attentionState(sample.court.overallState)) problems.push("selected camera needs attention");
  if (options.expectedIssue && sample.court.overallState !== "HEALTHY") problems.push("selected camera is not healthy before fault injection");
  if (sample.peerCourts.some((peer) => attentionState(peer.overallState))) problems.push("a peer camera needs attention");
  return problems;
}

function maximumGap(values) {
  if (values.length < 2) return null;
  let maximum = 0;
  for (let index = 1; index < values.length; index += 1) maximum = Math.max(maximum, values[index] - values[index - 1]);
  return maximum;
}

function pathTransitions(samples) {
  const transitions = [];
  let previous = null;
  for (const sample of samples) {
    const current = Object.fromEntries(["raw", "preview", "program"].map((branch) => [branch, Boolean(sample.court.paths?.[branch]?.ready)]));
    if (previous) {
      for (const branch of Object.keys(current)) {
        if (current[branch] !== previous[branch]) transitions.push({ branch, ready: current[branch], at: sample.receivedAt });
      }
    }
    previous = current;
  }
  return transitions;
}

function browserTransitions(samples) {
  const transitions = [];
  let previous = null;
  for (const sample of samples) {
    const browser = sample.court.browser;
    const current = browser ? {
      state: browser.state,
      pageLoadedAt: browser.pageLoadedAt,
      reconnectCount: browser.reconnectCount,
      reloadCount: browser.reloadCount
    } : null;
    if (JSON.stringify(current) !== JSON.stringify(previous)) transitions.push({ at: sample.receivedAt, ...current });
    previous = current;
  }
  return transitions;
}

function operationalErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP [0-9]{3}/.test(message)) return message.match(/HTTP [0-9]{3}/)?.[0].replace(" ", "_") ?? "HTTP_ERROR";
  if (/timeout|aborted/i.test(message)) return "TIMEOUT";
  if (/missing from the monitoring snapshot/.test(message)) return "COURT_MISSING";
  if (/snapshot timestamps are invalid/.test(message)) return "INVALID_SNAPSHOT_TIMESTAMP";
  return "MONITOR_API_ERROR";
}

function verdict(status, options, details) {
  return {
    status,
    courtNumber: options.courtNumber,
    expectedIssue: options.expectedIssue,
    requireRecovery: options.requireRecovery,
    allowedPeerCourts: options.allowedPeerCourts,
    ...details
  };
}

function usage() {
  return "Usage: MONITOR_API_TOKEN=... ./infra/monitoring/capture-fault-evidence.mjs --court N --output /protected/evidence.jsonl [--duration-seconds 120] [--interval-ms 1000] [--max-snapshot-age-ms 15000] [--expected-issue CODE] [--require-recovery] [--allowed-peer-courts 2,3]";
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const token = process.env.MONITOR_API_TOKEN?.trim();
  if (!token) throw new Error("MONITOR_API_TOKEN is required.");
  const summary = await captureEvidence({ ...parsed, token });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.status === "FAIL" || summary.status === "INVALID") process.exitCode = 2;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`fault evidence error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
