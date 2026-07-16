import express from "express";
import { AgentCollector } from "./collectors.js";
import { loadAgentConfig } from "./config.js";
import { MONITORING_CONTRACT_VERSION, type AgentSnapshot } from "./contracts.js";
import { AgentMetrics } from "./agentMetrics.js";
import { bearerAuth } from "./security.js";
import { ContentAnalyzerManager } from "./contentAnalysis.js";

const config = loadAgentConfig();
const app = express();
const contentAnalyzer = new ContentAnalyzerManager({
  ffmpegPath: config.contentAnalyzerFfmpegPath,
  ffprobePath: config.contentAnalyzerFfprobePath,
  sources: config.contentAnalyzerCourts.map((courtNumber) => ({
    courtNumber,
    url: `${config.contentAnalyzerRtspBaseUrl}/court${courtNumber}_raw`
  }))
});
contentAnalyzer.start();
const collector = new AgentCollector(config, () => contentAnalyzer.snapshots());
const metrics = new AgentMetrics();
let latest: AgentSnapshot | null = null;

app.disable("x-powered-by");
app.get("/healthz", (_req, res) => {
  const ageMs = latest ? Date.now() - Date.parse(latest.generatedAt) : null;
  res.status(ageMs != null && ageMs <= config.intervalMs * 3 ? 200 : 503).json({
    version: MONITORING_CONTRACT_VERSION,
    status: ageMs != null && ageMs <= config.intervalMs * 3 ? "ok" : "stale",
    agentId: config.agentId,
    role: config.role,
    ageMs
  });
});
app.get("/metrics", bearerAuth(config.token), async (_req, res) => {
  metrics.updateContentAnalysis(config.agentId, config.role === "compositor" ? config.assignedCourts : [], contentAnalyzer.snapshots());
  res.type(metrics.registry.contentType).send(await metrics.registry.metrics());
});
app.get("/v1/snapshot", bearerAuth(config.token), (_req, res) => {
  if (!latest) {
    res.status(503).json({ error: "No completed collection." });
    return;
  }
  res.json({ ...latest, contentAnalysis: contentAnalyzer.snapshots() });
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

const server = app.listen(config.port, config.bind, () => {
  console.log(`scorecheck-monitor-agent ${config.agentId} listening on ${config.bind}:${config.port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  server.closeIdleConnections();
  await Promise.all([
    new Promise<void>((resolve) => server.close(() => resolve())),
    contentAnalyzer.stop()
  ]);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
