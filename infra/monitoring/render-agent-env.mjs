import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");
const agentId = safeId(required("MONITOR_AGENT_ID"));
const role = roleValue(required("MONITOR_AGENT_ROLE"));
const values = {
  MONITOR_AGENT_ID: agentId,
  MONITOR_AGENT_ROLE: role,
  MONITOR_AGENT_TOKEN: required("MONITOR_AGENT_TOKEN"),
  MONITOR_AGENT_BIND: required("MONITOR_AGENT_BIND"),
  MONITOR_AGENT_PORT: integer(process.env.MONITOR_AGENT_PORT ?? "9108", 1, 65_535),
  MONITOR_AGENT_INTERVAL_MS: integer(process.env.MONITOR_AGENT_INTERVAL_MS ?? "5000", 1_000, 300_000),
  MONITOR_AGENT_CONTAINERS: safeIdList(process.env.MONITOR_AGENT_CONTAINERS ?? ""),
  MONITOR_DISK_PATH: process.env.MONITOR_DISK_PATH?.trim() || "/",
  DOCKER_API_URL: process.env.DOCKER_API_URL?.trim() || "http://127.0.0.1:2375",
  MEDIAMTX_API_URL: optionalHttpUrl("MEDIAMTX_API_URL"),
  MEDIAMTX_METRICS_URL: optionalHttpUrl("MEDIAMTX_METRICS_URL"),
  LIVEKIT_METRICS_URL: optionalHttpUrl("LIVEKIT_METRICS_URL"),
  EGRESS_METRICS_URL: optionalHttpUrl("EGRESS_METRICS_URL"),
  EGRESS_HEALTH_URL: optionalHttpUrl("EGRESS_HEALTH_URL")
};

await mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, `agent-${agentId}.env`);
await writeFile(outputPath, envFile(values), { encoding: "utf8", mode: 0o600 });
await chmod(outputPath, 0o600);
console.log(`Rendered protected agent configuration for ${agentId}.`);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function safeId(value) {
  if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(value)) throw new Error(`Invalid bounded identifier: ${value}`);
  return value;
}

function roleValue(value) {
  if (!["mediamtx", "commentary", "compositor", "worker", "venue", "observability"].includes(value)) throw new Error("Invalid agent role.");
  return value;
}

function safeIdList(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map(safeId).join(",");
}

function optionalHttpUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) return "";
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${name} must use HTTP(S).`);
  return parsed.toString();
}

function integer(value, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected integer from ${min} to ${max}.`);
  return parsed;
}

function envFile(record) {
  return Object.entries(record).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join("\n") + "\n";
}
