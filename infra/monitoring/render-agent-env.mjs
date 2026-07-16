import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");
const agentId = safeId(required("MONITOR_AGENT_ID"));
const role = roleValue(required("MONITOR_AGENT_ROLE"));
const assignedCourts = parseCourtList(process.env.MONITOR_AGENT_COURTS ?? "", "MONITOR_AGENT_COURTS");
const contentAnalyzerCourts = parseCourtList(process.env.MONITOR_CONTENT_ANALYZER_COURTS ?? "", "MONITOR_CONTENT_ANALYZER_COURTS");
const contentAnalyzerRtspBaseUrl = optionalRtspOrigin("MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL");
if (contentAnalyzerCourts.length > 0) {
  if (role !== "compositor") throw new Error("Camera-content analysis may run only on compositor agents.");
  if (!contentAnalyzerRtspBaseUrl) throw new Error("Camera-content analysis requires MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL.");
  if (contentAnalyzerCourts.some((court) => !assignedCourts.includes(court))) throw new Error("Camera-content analyzer courts must be owned by the compositor agent.");
} else if (contentAnalyzerRtspBaseUrl) {
  throw new Error("MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL requires at least one analyzer court.");
}
const values = {
  MONITOR_AGENT_ID: agentId,
  MONITOR_AGENT_ROLE: role,
  MONITOR_AGENT_TOKEN: required("MONITOR_AGENT_TOKEN"),
  MONITOR_AGENT_BIND: required("MONITOR_AGENT_BIND"),
  MONITOR_AGENT_PORT: integer(process.env.MONITOR_AGENT_PORT ?? "9108", 1, 65_535),
  MONITOR_AGENT_INTERVAL_MS: integer(process.env.MONITOR_AGENT_INTERVAL_MS ?? "5000", 1_000, 300_000),
  MONITOR_AGENT_CONTAINERS: safeIdList(process.env.MONITOR_AGENT_CONTAINERS ?? ""),
  MONITOR_AGENT_COURTS: assignedCourts.join(","),
  MONITOR_DISK_PATH: process.env.MONITOR_DISK_PATH?.trim() || "/",
  FFMPEG_PROGRESS_DIR: process.env.FFMPEG_PROGRESS_DIR?.trim() || "",
  DOCKER_API_URL: process.env.DOCKER_API_URL?.trim() || "http://127.0.0.1:2375",
  MEDIAMTX_API_URL: optionalHttpUrl("MEDIAMTX_API_URL"),
  MEDIAMTX_METRICS_URL: optionalHttpUrl("MEDIAMTX_METRICS_URL"),
  LIVEKIT_METRICS_URL: optionalHttpUrl("LIVEKIT_METRICS_URL"),
  EGRESS_METRICS_URL: optionalHttpUrl("EGRESS_METRICS_URL"),
  EGRESS_HEALTH_URL: optionalHttpUrl("EGRESS_HEALTH_URL"),
  MONITOR_EGRESS_MAX_WEB_REQUESTS: integer(process.env.MONITOR_EGRESS_MAX_WEB_REQUESTS ?? "1", 1, 32),
  MONITOR_CONTENT_ANALYZER_COURTS: contentAnalyzerCourts.join(","),
  MONITOR_CONTENT_ANALYZER_RTSP_BASE_URL: contentAnalyzerRtspBaseUrl,
  MONITOR_CONTENT_ANALYZER_FFMPEG_PATH: executablePath(process.env.MONITOR_CONTENT_ANALYZER_FFMPEG_PATH ?? "/usr/bin/ffmpeg"),
  MONITOR_CONTENT_ANALYZER_FFPROBE_PATH: executablePath(process.env.MONITOR_CONTENT_ANALYZER_FFPROBE_PATH ?? "/usr/bin/ffprobe")
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

function parseCourtList(value, field) {
  const courts = value.split(",").map((entry) => entry.trim()).filter(Boolean).map(Number);
  if (courts.some((court) => !Number.isInteger(court) || court < 1 || court > 8)) throw new Error(`${field} must contain court numbers 1-8.`);
  return [...new Set(courts)].sort((left, right) => left - right);
}

function optionalHttpUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) return "";
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${name} must use HTTP(S).`);
  return parsed.toString();
}

function optionalRtspOrigin(name) {
  const value = process.env[name]?.trim();
  if (!value) return "";
  const parsed = new URL(value);
  if (parsed.protocol !== "rtsp:" || parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    throw new Error(`${name} must be a credential-free RTSP origin.`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

function executablePath(value) {
  const parsed = value.trim();
  if (!parsed || parsed.length > 512 || /[\r\n\0]/.test(parsed)) throw new Error("Invalid analyzer executable path.");
  return parsed;
}

function integer(value, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected integer from ${min} to ${max}.`);
  return parsed;
}

function envFile(record) {
  return Object.entries(record).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join("\n") + "\n";
}
