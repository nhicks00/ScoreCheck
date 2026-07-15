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
  ["NEXT_PUBLIC_DEFAULT_TIMEZONE", env.timezone]
];

pushIfPresent(vercelLines, "MEDIAMTX_WHEP_BASE_URL", env.mediamtxWhepBaseUrl);
pushIfPresent(vercelLines, "MEDIAMTX_HLS_BASE_URL", env.mediamtxHlsBaseUrl);
pushIfPresent(vercelLines, "MEDIAMTX_READ_USER", env.mediamtxReadUser);
pushIfPresent(vercelLines, "MEDIAMTX_READ_PASS", env.mediamtxReadPass);
pushIfPresent(vercelLines, "MEDIAMTX_RTMP_INGEST_BASE", env.mediamtxRtmpIngestBase);
pushIfPresent(vercelLines, "COMMUNITY_MEDIA_WHEP_BASE_URL", env.communityMediaWhepBaseUrl);
pushIfPresent(vercelLines, "COMMUNITY_MEDIA_READ_USER", env.communityMediaReadUser);
pushIfPresent(vercelLines, "COMMUNITY_MEDIA_READ_PASS", env.communityMediaReadPass);
// Capacity zero is an intentional fail-closed deployment state. Always export
// it so a previous positive Vercel value cannot remain active by omission.
vercelLines.push(["COMMUNITY_MEDIA_MAX_PER_COURT", String(env.communityMediaMaxPerCourt)]);
vercelLines.push(["COMMUNITY_MEDIA_MAX_TOTAL", String(env.communityMediaMaxTotal)]);
pushIfPresent(vercelLines, "COMMUNITY_MEDIA_SESSION_SECONDS", String(env.communityMediaSessionSeconds));
pushIfPresent(vercelLines, "NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL", process.env.NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL ?? "");
pushIfPresent(vercelLines, "LIVEKIT_COMMENTARY_API_KEY", process.env.LIVEKIT_COMMENTARY_API_KEY ?? "");
pushIfPresent(vercelLines, "LIVEKIT_COMMENTARY_API_SECRET", process.env.LIVEKIT_COMMENTARY_API_SECRET ?? "");
pushIfPresent(vercelLines, "LIVEKIT_COMMENTARY_ROOM_PREFIX", process.env.LIVEKIT_COMMENTARY_ROOM_PREFIX ?? "");
pushIfPresent(vercelLines, "COMMENTATOR_PASSCODE", process.env.COMMENTATOR_PASSCODE ?? "");
pushIfPresent(vercelLines, "PROGRAM_PAGE_TOKEN", process.env.PROGRAM_PAGE_TOKEN ?? "");
pushIfPresent(vercelLines, "MONITOR_PUBLIC_URL", process.env.MONITOR_PUBLIC_URL ?? "");
pushIfPresent(vercelLines, "MONITOR_API_TOKEN", process.env.MONITOR_API_TOKEN ?? "");
pushIfPresent(vercelLines, "MONITOR_BROWSER_HEARTBEAT_SECRET", process.env.MONITOR_BROWSER_HEARTBEAT_SECRET ?? "");

const workerLines = [
  ["NODE_ENV", "production"],
  ["WORKER_ID", process.env.WORKER_ID || "scorecheck-worker-prod"],
  ["NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.supabaseAnonKey],
  ["SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey],
  ["ADMIN_SECRET", env.adminSecret],
  ["NEXT_PUBLIC_SITE_URL", env.publicSiteUrl],
  ["WORKER_ACTIVE_INTERVAL_MS", process.env.WORKER_ACTIVE_INTERVAL_MS || "1800"],
  ["WORKER_IDLE_INTERVAL_MS", process.env.WORKER_IDLE_INTERVAL_MS || "8000"],
  ["WORKER_OFF_EVENT_INTERVAL_MS", process.env.WORKER_OFF_EVENT_INTERVAL_MS || "900000"]
];
pushIfPresent(workerLines, "COMMUNITY_MEDIA_WHEP_BASE_URL", env.communityMediaWhepBaseUrl);
pushIfPresent(workerLines, "COMMUNITY_MEDIA_READ_USER", env.communityMediaReadUser);
pushIfPresent(workerLines, "COMMUNITY_MEDIA_READ_PASS", env.communityMediaReadPass);

for (let court = 1; court <= env.courtCount; court += 1) {
  pushIfPresent(vercelLines, `COURT_${court}_PREVIEW_STREAM_PATH`, process.env[`COURT_${court}_PREVIEW_STREAM_PATH`] ?? "");
  pushIfPresent(vercelLines, `COURT_${court}_PROGRAM_STREAM_PATH`, process.env[`COURT_${court}_PROGRAM_STREAM_PATH`] ?? "");
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
