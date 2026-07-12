import express from "express";
import { AgentCollector } from "./collectors.js";
import { loadAgentConfig } from "./config.js";
import type { AgentSnapshot } from "./contracts.js";
import { AgentMetrics } from "./agentMetrics.js";
import { bearerAuth } from "./security.js";

const config = loadAgentConfig();
const app = express();
const collector = new AgentCollector(config);
const metrics = new AgentMetrics();
let latest: AgentSnapshot | null = null;

app.disable("x-powered-by");
app.get("/healthz", (_req, res) => {
  const ageMs = latest ? Date.now() - Date.parse(latest.generatedAt) : null;
  res.status(ageMs != null && ageMs <= config.intervalMs * 3 ? 200 : 503).json({
    version: 1,
    status: ageMs != null && ageMs <= config.intervalMs * 3 ? "ok" : "stale",
    agentId: config.agentId,
    role: config.role,
    ageMs
  });
});
app.get("/metrics", bearerAuth(config.token), async (_req, res) => {
  res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
});
app.get("/v1/snapshot", bearerAuth(config.token), (_req, res) => {
  if (!latest) {
    res.status(503).json({ error: "No completed collection." });
    return;
  }
  res.json(latest);
});

async function collect() {
  try {
    latest = await collector.collect();
    metrics.update(latest);
  } catch (error) {
    console.error("monitor agent collection failed", error instanceof Error ? error.message : "unknown error");
  }
}

await collect();
const timer = setInterval(() => void collect(), config.intervalMs);
timer.unref();

app.listen(config.port, config.bind, () => {
  console.log(`scorecheck-monitor-agent ${config.agentId} listening on ${config.bind}:${config.port}`);
});
