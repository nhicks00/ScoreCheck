#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_DURATION_SECONDS = 120;
const DEFAULT_MAX_CHECKPOINT_AGE_MS = 120_000;
const MAX_DURABLE_EPISODES = 100;
const MAX_DURABLE_CHILD_ROWS = 2_000;
const DURABLE_TABLES = ["monitoring_incidents", "monitoring_incident_events", "incident_notifications", "monitoring_checkpoints"];

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
  const monitorErrors = errors.filter((row) => !String(row.source ?? "").startsWith("durable_"));
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
  const durable = evaluateDurableEvidence(rows, options);
  const baselineProblems = faultReadyBaselineProblems(baseline, options, durable);
  const baselineClean = baselineProblems.length === 0;
  let status = "PASS";
  let reason = "Expected issue and isolation evidence were captured.";
  if (!baselineClean) {
    status = "INVALID";
    reason = `The first sample was not fault-ready: ${baselineProblems.join("; ")}`;
  } else if (collectorFailures > 0 || notificationFailures > 0 || deadManFailures > 0 || staleSnapshotSamples > 0 || monitorErrors.length > 0) {
    status = "INVALID";
    reason = "Monitoring collection was not continuously healthy.";
  } else if (durable.invalidReasons.length > 0) {
    status = "INVALID";
    reason = `Durable evidence collection was invalid: ${durable.invalidReasons.join("; ")}`;
  } else if (options.expectedIssue && !firstIssue) {
    status = "FAIL";
    reason = `Expected issue ${options.expectedIssue} was not observed.`;
  } else if (options.expectedIssue && options.requireRecovery && !recovery) {
    status = "FAIL";
    reason = `Expected issue ${options.expectedIssue} did not recover inside the capture window.`;
  } else if (unexpectedIncidents.size > 0 || unexpectedPeerStates.size > 0) {
    status = "FAIL";
    reason = "An unapproved incident or peer-camera impact occurred during the selected-camera fault.";
  } else if (durable.failureReasons.length > 0) {
    status = "FAIL";
    reason = `Durable fault evidence failed: ${durable.failureReasons.join("; ")}`;
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
    browserTransitions: browserTransitions(samples),
    durableEvidence: durable.summary
  });
}

export async function captureEvidence(options, dependencies = {}) {
  const fetchSnapshot = dependencies.fetchSnapshot ?? (() => loadSnapshot(options.apiBase, options.token));
  const fetchDurableEvidence = options.durableEvidence
    ? dependencies.fetchDurableEvidence ?? createDurableEvidenceReader(options.supabaseUrl, options.supabaseServiceRoleKey)
    : null;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const now = dependencies.now ?? (() => Date.now());
  const rows = [];
  const startedAtMs = now();
  const deadlineMs = startedAtMs + options.durationSeconds * 1_000;
  const file = await openProtectedOutput(options.output);
  try {
    await writeRow(file, {
      kind: "header",
      schemaVersion: 2,
      startedAt: new Date(startedAtMs).toISOString(),
      courtNumber: options.courtNumber,
      expectedIssue: options.expectedIssue,
      requireRecovery: options.requireRecovery,
      durableEvidence: options.durableEvidence,
      requirePushoverOpen: options.requirePushoverOpen,
      requirePushoverRecovery: options.requirePushoverRecovery,
      requirePushoverAcknowledgement: options.requirePushoverAcknowledgement,
      allowedPeerCourts: options.allowedPeerCourts,
      intervalMs: options.intervalMs,
      maxSnapshotAgeMs: options.maxSnapshotAgeMs,
      maxCheckpointAgeMs: options.maxCheckpointAgeMs,
      durationSeconds: options.durationSeconds
    });
    if (fetchDurableEvidence) {
      const row = await durableEvidenceRow(fetchDurableEvidence, "durable_baseline", options, startedAtMs, now());
      rows.push(row);
      await writeRow(file, row);
    }
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
          const durable = evaluateDurableEvidence(rows, options);
          const problems = faultReadyBaselineProblems(row, options, durable);
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
    if (fetchDurableEvidence) {
      const row = await durableEvidenceRow(fetchDurableEvidence, "durable_final", options, startedAtMs, now());
      rows.push(row);
      await writeRow(file, row);
    }
    const summary = evaluateEvidence(rows, options);
    await writeRow(file, { kind: "summary", completedAt: new Date(now()).toISOString(), ...summary });
    return summary;
  } finally {
    await file.close();
  }
}

async function durableEvidenceRow(fetchDurableEvidence, kind, options, startedAtMs, capturedAtMs) {
  try {
    return await fetchDurableEvidence({
      kind,
      courtNumber: options.courtNumber,
      startedAt: new Date(startedAtMs).toISOString(),
      capturedAt: new Date(capturedAtMs).toISOString()
    });
  } catch (error) {
    return {
      kind: "error",
      source: kind,
      observedAt: new Date(capturedAtMs).toISOString(),
      code: "DURABLE_EVIDENCE_ERROR"
    };
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

export function createDurableEvidenceReader(supabaseUrl, serviceRoleKey) {
  if (!supabaseUrl || !serviceRoleKey) throw new Error("Durable evidence requires protected Supabase credentials.");
  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) })
    }
  });
  return async ({ kind, startedAt, capturedAt }) => {
    if (kind === "durable_baseline") return durableCommon(db, kind, capturedAt);

    const { data, error } = await db.from("monitoring_incidents")
      .select("id,court_number,issue_code,severity,status,opened_at,last_observed_at,acknowledged_at,resolved_at")
      .gte("opened_at", startedAt)
      .lte("opened_at", capturedAt)
      .order("opened_at", { ascending: true })
      .limit(MAX_DURABLE_EPISODES + 1);
    if (error) throw error;
    const episodeRows = data ?? [];
    const truncated = episodeRows.length > MAX_DURABLE_EPISODES;
    const episodes = episodeRows.slice(0, MAX_DURABLE_EPISODES).map(durableIncident);
    const incidentIds = episodes.map((incident) => incident.id);
    const [eventResult, notificationResult] = incidentIds.length === 0
      ? [{ rows: [], truncated: false }, { rows: [], truncated: false }]
      : await Promise.all([durableEvents(db, incidentIds), durableNotifications(db, incidentIds)]);
    const common = await durableCommon(db, kind, capturedAt);
    return {
      ...common,
      episodes,
      events: eventResult.rows,
      notifications: notificationResult.rows,
      truncated: truncated || eventResult.truncated || notificationResult.truncated
    };
  };
}

async function durableCommon(db, kind, capturedAt) {
  const [contractVersion, checkpoint, activeIncidents, counts] = await Promise.all([
    episodeContract(db),
    latestCheckpoint(db),
    activeIncidentRows(db),
    durableTableCounts(db)
  ]);
  return { kind, capturedAt, contractVersion, checkpoint, activeIncidents, counts };
}

async function episodeContract(db) {
  const { data, error } = await db.rpc("monitoring_incident_episode_contract");
  if (error) throw error;
  return data;
}

async function latestCheckpoint(db) {
  const { data, error } = await db.from("monitoring_checkpoints")
    .select("scope,observed_at,updated_at")
    .eq("scope", "global")
    .maybeSingle();
  if (error) throw error;
  return data ? { scope: String(data.scope), observedAt: String(data.observed_at), updatedAt: String(data.updated_at) } : null;
}

async function activeIncidentRows(db) {
  const { data, error } = await db.from("monitoring_incidents")
    .select("id,court_number,issue_code,severity,status,opened_at,last_observed_at,acknowledged_at,resolved_at")
    .neq("status", "resolved")
    .order("opened_at", { ascending: true })
    .limit(MAX_DURABLE_EPISODES + 1);
  if (error) throw error;
  return (data ?? []).slice(0, MAX_DURABLE_EPISODES).map(durableIncident);
}

async function durableTableCounts(db) {
  const results = await Promise.all(DURABLE_TABLES.map(async (table) => {
    const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
    if (error || count == null) throw error ?? new Error(`Durable count unavailable for ${table}.`);
    return [table, count];
  }));
  return Object.fromEntries(results);
}

async function durableEvents(db, incidentIds) {
  const { data, error } = await db.from("monitoring_incident_events")
    .select("incident_id,event_type,detail,occurred_at")
    .in("incident_id", incidentIds)
    .order("occurred_at", { ascending: true })
    .limit(MAX_DURABLE_CHILD_ROWS + 1);
  if (error) throw error;
  const rows = data ?? [];
  const bounded = rows.slice(0, MAX_DURABLE_CHILD_ROWS).map((row) => ({
    incidentId: String(row.incident_id),
    eventType: String(row.event_type),
    occurredAt: String(row.occurred_at),
    resolutionKind: durableResolutionKind(row.detail)
  }));
  return { rows: bounded, truncated: rows.length > MAX_DURABLE_CHILD_ROWS };
}

async function durableNotifications(db, incidentIds) {
  const { data, error } = await db.from("incident_notifications")
    .select("incident_id,provider,notification_kind,status,submitted_at,accepted_at,delivered_at,acknowledged_at,expired_at,escalated_at,provider_error_code")
    .in("incident_id", incidentIds)
    .order("submitted_at", { ascending: true })
    .limit(MAX_DURABLE_CHILD_ROWS + 1);
  if (error) throw error;
  const rows = data ?? [];
  const bounded = rows.slice(0, MAX_DURABLE_CHILD_ROWS).map((row) => ({
    incidentId: String(row.incident_id),
    provider: String(row.provider),
    kind: String(row.notification_kind),
    status: String(row.status),
    submittedAt: String(row.submitted_at),
    acceptedAt: optionalString(row.accepted_at),
    deliveredAt: optionalString(row.delivered_at),
    acknowledgedAt: optionalString(row.acknowledged_at),
    expiredAt: optionalString(row.expired_at),
    escalatedAt: optionalString(row.escalated_at),
    providerErrorCode: optionalString(row.provider_error_code)
  }));
  return { rows: bounded, truncated: rows.length > MAX_DURABLE_CHILD_ROWS };
}

function durableIncident(row) {
  return {
    id: String(row.id),
    courtNumber: typeof row.court_number === "number" ? row.court_number : null,
    issueCode: String(row.issue_code),
    severity: String(row.severity),
    status: String(row.status),
    openedAt: String(row.opened_at),
    lastObservedAt: String(row.last_observed_at),
    acknowledgedAt: optionalString(row.acknowledged_at),
    resolvedAt: optionalString(row.resolved_at)
  };
}

function durableResolutionKind(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = value.resolutionKind;
  return typeof kind === "string" && /^[A-Z0-9_]{3,80}$/.test(kind) ? kind : null;
}

function optionalString(value) {
  return typeof value === "string" ? value : null;
}

function parseArgs(argv) {
  const options = {
    courtNumber: null,
    durationSeconds: DEFAULT_DURATION_SECONDS,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxSnapshotAgeMs: 15_000,
    maxCheckpointAgeMs: DEFAULT_MAX_CHECKPOINT_AGE_MS,
    expectedIssue: null,
    requireRecovery: false,
    durableEvidence: false,
    requirePushoverOpen: false,
    requirePushoverRecovery: false,
    requirePushoverAcknowledgement: false,
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
    else if (argument === "--max-checkpoint-age-ms") options.maxCheckpointAgeMs = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--expected-issue") options.expectedIssue = requiredValue(argv, ++index, argument);
    else if (argument === "--require-recovery") options.requireRecovery = true;
    else if (argument === "--durable-evidence") options.durableEvidence = true;
    else if (argument === "--require-pushover-open") options.requirePushoverOpen = true;
    else if (argument === "--require-pushover-recovery") options.requirePushoverRecovery = true;
    else if (argument === "--require-pushover-acknowledgement") options.requirePushoverAcknowledgement = true;
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
  integerRange(options.maxCheckpointAgeMs, "maximum checkpoint age milliseconds", 60_000, 300_000);
  if (!options.output) throw new Error("--output is required.");
  if (options.expectedIssue && !/^[A-Z0-9_]{3,100}$/.test(options.expectedIssue)) throw new Error("Invalid expected issue code.");
  if (options.requireRecovery && !options.expectedIssue) throw new Error("--require-recovery requires --expected-issue.");
  const pushoverRequirement = options.requirePushoverOpen || options.requirePushoverRecovery || options.requirePushoverAcknowledgement;
  if (pushoverRequirement && !options.durableEvidence) throw new Error("Pushover evidence requirements require --durable-evidence.");
  if (pushoverRequirement && !options.expectedIssue) throw new Error("Pushover evidence requirements require --expected-issue.");
  if (options.requirePushoverRecovery && !options.requireRecovery) throw new Error("--require-pushover-recovery requires --require-recovery.");
  if (options.requirePushoverAcknowledgement && !options.requirePushoverOpen) throw new Error("--require-pushover-acknowledgement requires --require-pushover-open.");
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

function faultReadyBaselineProblems(sample, options, durable = { baselineProblems: [] }) {
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
  problems.push(...durable.baselineProblems);
  return problems;
}

export function evaluateDurableEvidence(rows, options) {
  if (!options.durableEvidence) {
    return {
      baselineProblems: [],
      invalidReasons: [],
      failureReasons: [],
      summary: { enabled: false }
    };
  }
  const baseline = rows.find((row) => row.kind === "durable_baseline") ?? null;
  const final = rows.find((row) => row.kind === "durable_final") ?? null;
  const baselineProblems = durableRowProblems(baseline, options, "baseline");
  const invalidReasons = [...baselineProblems, ...durableRowProblems(final, options, "final")];
  const failureReasons = [];
  let expectedEpisode = null;
  let unexpectedEpisodes = [];
  const countDeltas = durableCountDeltas(baseline?.counts, final?.counts);

  if (final) {
    const episodes = Array.isArray(final.episodes) ? final.episodes : [];
    const matching = options.expectedIssue
      ? episodes.filter((episode) => expectedDurableEpisode(episode, options))
      : [];
    unexpectedEpisodes = episodes.filter((episode) => !expectedDurableEpisode(episode, options));
    if (options.expectedIssue && matching.length !== 1) {
      failureReasons.push(`expected exactly one durable ${options.expectedIssue} episode, observed ${matching.length}`);
    } else if (matching.length === 1) {
      expectedEpisode = matching[0];
      verifyEpisode(expectedEpisode, final, options, failureReasons);
      verifyDurableGrowth(countDeltas, options, failureReasons);
    }
    if (!options.expectedIssue && episodes.length > 0) failureReasons.push("unexpected durable incident episodes occurred");
    else if (unexpectedEpisodes.length > 0) failureReasons.push(`${unexpectedEpisodes.length} unapproved durable incident episode(s) occurred`);
  }

  return {
    baselineProblems,
    invalidReasons,
    failureReasons,
    summary: {
      enabled: true,
      baselineCapturedAt: baseline?.capturedAt ?? null,
      finalCapturedAt: final?.capturedAt ?? null,
      episodeId: expectedEpisode?.id ?? null,
      episodeStatus: expectedEpisode?.status ?? null,
      episodeOpenedAt: expectedEpisode?.openedAt ?? null,
      episodeResolvedAt: expectedEpisode?.resolvedAt ?? null,
      unexpectedEpisodes: unexpectedEpisodes.map((episode) => ({
        id: episode.id,
        courtNumber: episode.courtNumber,
        issueCode: episode.issueCode
      })),
      checkpointAdvanced: checkpointAdvanced(baseline, final),
      countDeltas,
      invalidReasons,
      failureReasons
    }
  };
}

function durableRowProblems(row, options, label) {
  if (!row) return [`durable ${label} evidence is missing`];
  const problems = [];
  if (row.contractVersion !== 1) problems.push(`durable ${label} episode contract is unavailable`);
  if (!row.checkpoint) problems.push(`durable ${label} checkpoint is missing`);
  else {
    const checkpointAgeMs = Date.parse(row.capturedAt) - Date.parse(row.checkpoint.observedAt);
    if (!Number.isFinite(checkpointAgeMs) || checkpointAgeMs < -5_000 || checkpointAgeMs > options.maxCheckpointAgeMs) {
      problems.push(`durable ${label} checkpoint is stale or invalid`);
    }
  }
  if (!row.counts || DURABLE_TABLES.some((table) => !Number.isInteger(row.counts[table]) || row.counts[table] < 0)) {
    problems.push(`durable ${label} table counts are invalid`);
  }
  if (label === "baseline" && (!Array.isArray(row.activeIncidents) || row.activeIncidents.length > 0)) {
    problems.push("durable baseline has active incidents");
  }
  if (label === "final") {
    if (!Array.isArray(row.episodes) || !Array.isArray(row.events) || !Array.isArray(row.notifications)) {
      problems.push("durable final episode data is malformed");
    }
    if (row.truncated) problems.push("durable final incident window exceeded its bound");
  }
  return problems;
}

function expectedDurableEpisode(episode, options) {
  if (!options.expectedIssue || episode.issueCode !== options.expectedIssue) return false;
  return episode.courtNumber === options.courtNumber
    || episode.courtNumber === null
    || options.allowedPeerCourts.includes(episode.courtNumber);
}

function verifyEpisode(episode, final, options, failureReasons) {
  const events = (final.events ?? []).filter((event) => event.incidentId === episode.id);
  const notifications = (final.notifications ?? []).filter((notification) => notification.incidentId === episode.id);
  if (events.filter((event) => event.eventType === "OPENED").length !== 1) {
    failureReasons.push("durable episode does not have exactly one OPENED event");
  }
  if (options.requireRecovery) {
    if (episode.status !== "resolved" || !episode.resolvedAt) failureReasons.push("durable episode is not resolved");
    if (events.filter((event) => event.eventType === "RESOLVED").length !== 1) {
      failureReasons.push("durable episode does not have exactly one RESOLVED event");
    }
    const resolution = events.find((event) => event.eventType === "RESOLVED")?.resolutionKind;
    if (resolution !== "DEPENDENCY_RECOVERED") failureReasons.push("durable episode did not close from observed dependency recovery");
  }
  if (options.requirePushoverAcknowledgement) {
    if (!episode.acknowledgedAt || events.filter((event) => event.eventType === "ACKNOWLEDGED").length !== 1) {
      failureReasons.push("durable episode does not have exactly one acknowledgement");
    }
  }
  const pushoverOpen = notifications.filter((notification) => notification.provider === "pushover" && notification.kind === "open");
  if (options.requirePushoverOpen) {
    if (pushoverOpen.length !== 1 || !["accepted", "delivered", "acknowledged", "cancelled"].includes(pushoverOpen[0]?.status)) {
      failureReasons.push("exactly one successful Pushover opening notification was not preserved");
    }
  }
  if (options.requirePushoverAcknowledgement && pushoverOpen[0]?.status !== "acknowledged") {
    failureReasons.push("Pushover opening notification was not acknowledged");
  }
  const pushoverRecovery = notifications.filter((notification) => notification.provider === "pushover" && notification.kind === "recovery");
  if (options.requirePushoverRecovery
    && (pushoverRecovery.length !== 1 || !["accepted", "delivered"].includes(pushoverRecovery[0]?.status))) {
    failureReasons.push("exactly one successful Pushover recovery notification was not preserved");
  }
  if (notifications.some((notification) => notification.status === "failed")) {
    failureReasons.push("a durable notification failed during the episode");
  }
}

function verifyDurableGrowth(deltas, options, failureReasons) {
  if (!deltas) {
    failureReasons.push("durable table-count growth is unavailable");
    return;
  }
  if (deltas.monitoring_incidents !== 1) failureReasons.push("durable incident table did not grow by exactly one episode");
  const minimumEvents = 1 + Number(options.requireRecovery) + Number(options.requirePushoverAcknowledgement);
  if (deltas.monitoring_incident_events < minimumEvents) {
    failureReasons.push(`durable event table grew by fewer than ${minimumEvents} required transitions`);
  }
  const minimumNotifications = Number(options.requirePushoverOpen) + Number(options.requirePushoverRecovery);
  if (deltas.incident_notifications < minimumNotifications) {
    failureReasons.push(`durable notification table grew by fewer than ${minimumNotifications} required rows`);
  }
}

function checkpointAdvanced(baseline, final) {
  if (!baseline?.checkpoint?.observedAt || !final?.checkpoint?.observedAt) return null;
  return Date.parse(final.checkpoint.observedAt) > Date.parse(baseline.checkpoint.observedAt);
}

function durableCountDeltas(baseline, final) {
  if (!baseline || !final) return null;
  return Object.fromEntries(Object.keys(final).map((table) => [table, final[table] - (baseline[table] ?? 0)]));
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
    durableEvidence: options.durableEvidence,
    requirePushoverOpen: options.requirePushoverOpen,
    requirePushoverRecovery: options.requirePushoverRecovery,
    requirePushoverAcknowledgement: options.requirePushoverAcknowledgement,
    allowedPeerCourts: options.allowedPeerCourts,
    ...details
  };
}

function usage() {
  return "Usage: MONITOR_API_TOKEN=... ./infra/monitoring/capture-fault-evidence.mjs --court N --output /protected/evidence.jsonl [--duration-seconds 120] [--interval-ms 1000] [--max-snapshot-age-ms 15000] [--max-checkpoint-age-ms 120000] [--expected-issue CODE] [--require-recovery] [--allowed-peer-courts 2,3] [--durable-evidence] [--require-pushover-open] [--require-pushover-recovery] [--require-pushover-acknowledgement]";
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const token = process.env.MONITOR_API_TOKEN?.trim();
  if (!token) throw new Error("MONITOR_API_TOKEN is required.");
  const supabaseUrl = parsed.durableEvidence ? process.env.SUPABASE_URL?.trim() : null;
  const supabaseServiceRoleKey = parsed.durableEvidence ? process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() : null;
  if (parsed.durableEvidence && (!supabaseUrl || !supabaseServiceRoleKey)) {
    throw new Error("--durable-evidence requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  const summary = await captureEvidence({ ...parsed, token, supabaseUrl, supabaseServiceRoleKey });
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
