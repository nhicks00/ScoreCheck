import express from "express";
import { Counter, Gauge, Registry } from "prom-client";
import { z } from "zod";
import { agentSnapshotSchema, type MonitorSnapshot } from "./contracts.js";
import { loadServiceConfig, type AgentTarget } from "./config.js";
import { buildMonitorSnapshot, type AgentRuntime } from "./correlator.js";
import { IncidentManager } from "./incidents.js";
import { IncidentStore } from "./incidentStore.js";
import { bearerAuth } from "./security.js";

const config = loadServiceConfig();
const app = express();
const registry = new Registry();
const agentFresh = new Gauge({ name: "scorecheck_monitor_agent_fresh", help: "Whether an expected host agent has reported within ten seconds.", labelNames: ["agent", "role"], registers: [registry] });
const agentPollErrors = new Counter({ name: "scorecheck_monitor_agent_poll_errors_total", help: "Agent snapshot poll errors.", labelNames: ["agent", "role"], registers: [registry] });
const snapshotGenerated = new Gauge({ name: "scorecheck_monitor_snapshot_generated_timestamp_seconds", help: "Unix timestamp of the latest monitor snapshot.", registers: [registry] });
const runtimes = new Map<string, AgentRuntime>(config.targets.map((target) => [target.id, {
  target,
  snapshot: null,
  lastSeenAt: null,
  lastErrorAt: null
}]));
const incidents = new IncidentManager();
const incidentStore = IncidentStore.create(config.supabaseUrl, config.supabaseServiceRoleKey);
if (incidentStore) {
  try {
    incidents.hydrate(await incidentStore.loadActive());
  } catch {
    console.error("durable incident state could not be loaded");
  }
}
let snapshot: MonitorSnapshot = buildMonitorSnapshot(config.targets, runtimes, config.courtCount, Date.now(), incidents.active());

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.get("/healthz", (_req, res) => {
  const ageMs = Date.now() - Date.parse(snapshot.generatedAt);
  res.status(ageMs <= config.intervalMs * 3 ? 200 : 503).json({ version: 1, status: ageMs <= config.intervalMs * 3 ? "ok" : "stale", ageMs });
});
app.get("/metrics", bearerAuth(config.token), async (_req, res) => {
  res.type(registry.contentType).send(await registry.metrics());
});
app.get("/v1/snapshot", bearerAuth(config.token), (_req, res) => res.json(snapshot));
app.post("/v1/alertmanager", bearerAuth(config.alertmanagerWebhookToken), async (req, res) => {
  try {
    const changed = incidents.applyWebhook(req.body);
    snapshot = buildMonitorSnapshot(config.targets, runtimes, config.courtCount, Date.now(), incidents.active());
    await persistIncidentChanges(changed);
    res.status(202).json({ accepted: changed.length });
  } catch {
    res.status(400).json({ error: "Invalid Alertmanager payload." });
  }
});
app.post("/v1/incidents/:id/acknowledge", bearerAuth(config.token), async (req, res) => {
  const incidentId = z.string().uuid().safeParse(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  const parsed = z.object({
    actor: z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.:@-]+$/),
    reason: z.string().trim().min(1).max(300)
  }).strict().safeParse(req.body);
  if (!incidentId.success || !parsed.success) {
    res.status(400).json({ error: "Invalid acknowledgement." });
    return;
  }
  const change = incidents.acknowledge(incidentId.data, parsed.data.actor);
  if (!change) {
    res.status(404).json({ error: "Active incident not found." });
    return;
  }
  snapshot = buildMonitorSnapshot(config.targets, runtimes, config.courtCount, Date.now(), incidents.active());
  await persistIncidentChanges([change]);
  res.json({ incident: change.incident, reason: parsed.data.reason });
});

async function pollAll() {
  await Promise.all(config.targets.map((target) => pollAgent(target)));
  snapshot = buildMonitorSnapshot(config.targets, runtimes, config.courtCount, Date.now(), incidents.active());
  snapshotGenerated.set(Date.parse(snapshot.generatedAt) / 1_000);
  agentFresh.reset();
  for (const agent of snapshot.agents) {
    agentFresh.set({ agent: agent.agentId, role: agent.role }, agent.ageMs != null && agent.ageMs <= 10_000 ? 1 : 0);
  }
}

async function pollAgent(target: AgentTarget) {
  const runtime = runtimes.get(target.id);
  if (!runtime) return;
  try {
    const response = await fetch(`${target.url}/v1/snapshot`, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    runtime.snapshot = agentSnapshotSchema.parse(await response.json());
    if (runtime.snapshot.agentId !== target.id || runtime.snapshot.role !== target.role) throw new Error("Agent identity mismatch.");
    runtime.lastSeenAt = new Date().toISOString();
  } catch {
    runtime.lastErrorAt = new Date().toISOString();
    agentPollErrors.inc({ agent: target.id, role: target.role });
  }
}

async function pingDeadMan() {
  if (!config.healthchecksPingUrl) return;
  try {
    await fetch(config.healthchecksPingUrl, { method: "POST", signal: AbortSignal.timeout(5_000) });
  } catch {
    console.error("external dead-man ping failed");
  }
}

async function persistIncidentChanges(changes: ReturnType<IncidentManager["applyWebhook"]>) {
  if (!incidentStore) return;
  try {
    for (const change of changes) await incidentStore.persist(change);
    await incidentStore.checkpoint(snapshot);
  } catch {
    console.error("durable incident state could not be persisted");
  }
}

async function checkpoint() {
  if (!incidentStore) return;
  try {
    await incidentStore.checkpoint(snapshot);
  } catch {
    console.error("monitor checkpoint could not be persisted");
  }
}

await pollAll();
const pollTimer = setInterval(() => void pollAll(), config.intervalMs);
pollTimer.unref();
if (config.healthchecksPingUrl) {
  void pingDeadMan();
  const deadManTimer = setInterval(() => void pingDeadMan(), config.healthchecksIntervalMs);
  deadManTimer.unref();
}
if (incidentStore) {
  void checkpoint();
  const checkpointTimer = setInterval(() => void checkpoint(), 60_000);
  checkpointTimer.unref();
}

app.listen(config.port, config.bind, () => {
  console.log(`scorecheck-monitor-service listening on ${config.bind}:${config.port}`);
});
