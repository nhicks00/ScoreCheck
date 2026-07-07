import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../../lib/env";
import { loadLocalEnv } from "../envLoader";

loadLocalEnv();
const env = getEnv();
const outputDir = path.join(process.cwd(), ".local");
fs.mkdirSync(outputDir, { recursive: true });

const vercelLines = [
  ["NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.supabaseAnonKey],
  ["SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey],
  ["ADMIN_SECRET", env.adminSecret],
  ["NEXT_PUBLIC_SITE_URL", env.publicSiteUrl],
  ["NEXT_PUBLIC_DEFAULT_EVENT_SLUG", env.defaultEventSlug],
  ["NEXT_PUBLIC_EVENT_NAME", env.eventName],
  ["NEXT_PUBLIC_COURT_COUNT", String(env.courtCount)],
  ["NEXT_PUBLIC_DEFAULT_TIMEZONE", env.timezone],
  ["MEDIAMTX_WHEP_BASE_URL", env.mediamtxWhepBaseUrl],
  ["MEDIAMTX_HLS_BASE_URL", env.mediamtxHlsBaseUrl]
];

pushIfPresent(vercelLines, "MEDIAMTX_READ_USER", env.mediamtxReadUser);
pushIfPresent(vercelLines, "MEDIAMTX_READ_PASS", env.mediamtxReadPass);
pushIfPresent(vercelLines, "MEDIAMTX_RTMP_INGEST_BASE", env.mediamtxRtmpIngestBase);

const workerLines = [
  ["NODE_ENV", "production"],
  ["WORKER_ID", process.env.WORKER_ID || "scorecheck-worker-prod"],
  ["NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.supabaseAnonKey],
  ["SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey],
  ["ADMIN_SECRET", env.adminSecret],
  ["NEXT_PUBLIC_SITE_URL", env.publicSiteUrl],
  ["WORKER_HEARTBEAT_MS", process.env.WORKER_HEARTBEAT_MS || "15000"]
];

for (let court = 1; court <= env.courtCount; court += 1) {
  pushIfPresent(vercelLines, `COURT_${court}_STREAM_PATH`, process.env[`COURT_${court}_STREAM_PATH`] ?? "");
}

fs.writeFileSync(path.join(outputDir, "vercel-env.generated.env"), serializeEnv(vercelLines));
fs.writeFileSync(path.join(outputDir, "worker-env.generated.env"), serializeEnv(workerLines));
console.log(`Wrote ${path.join(outputDir, "vercel-env.generated.env")}`);
console.log(`Wrote ${path.join(outputDir, "worker-env.generated.env")}`);

function serializeEnv(lines: string[][]) {
  return lines.map(([key, value]) => `${key}=${quote(value)}`).join("\n") + "\n";
}

function pushIfPresent(lines: string[][], key: string, value: string) {
  if (value) lines.push([key, value]);
}

function quote(value: string) {
  if (!value) return "";
  return /[\s"'\\]/.test(value) ? JSON.stringify(value) : value;
}
