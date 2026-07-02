import fs from "node:fs";
import path from "node:path";
import { courtIvsEnv, getEnv } from "../../lib/env";
import { loadLocalEnv } from "../envLoader";

loadLocalEnv();
const env = getEnv();
const generatedIvs = readGeneratedIvs();
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
  ["AWS_REGION", env.awsRegion],
  ["IVS_PLAYBACK_PRIVATE_KEY", env.ivsPlaybackPrivateKey],
  ["YOUTUBE_WORKER_SHARED_SECRET", env.youtubeWorkerSharedSecret]
];

pushIfPresent(vercelLines, "IVS_PLAYBACK_KEY_PAIR_ID", env.ivsPlaybackKeyPairId);
pushIfPresent(vercelLines, "IVS_PLAYBACK_KEY_PAIR_ARN", env.ivsPlaybackKeyPairArn);

const workerLines = [
  ["NODE_ENV", "production"],
  ["WORKER_ID", process.env.WORKER_ID || "scorecheck-youtube-worker-prod"],
  ["WORKER_MODE", process.env.WORKER_MODE || "all"],
  ["NEXT_PUBLIC_SUPABASE_URL", env.supabaseUrl],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", env.supabaseAnonKey],
  ["SUPABASE_SERVICE_ROLE_KEY", env.supabaseServiceRoleKey],
  ["ADMIN_SECRET", env.adminSecret],
  ["NEXT_PUBLIC_SITE_URL", env.publicSiteUrl],
  ["YOUTUBE_API_KEY", env.youtubeApiKey],
  ["YOUTUBE_CLIENT_ID", env.youtubeClientId],
  ["YOUTUBE_CLIENT_SECRET", env.youtubeClientSecret],
  ["YOUTUBE_REFRESH_TOKEN", env.youtubeRefreshToken],
  ["YOUTUBE_BOT_POSTING_ENABLED", String(env.youtubeBotPostingEnabled)],
  ["YOUTUBE_WORKER_SHARED_SECRET", env.youtubeWorkerSharedSecret],
  ["YOUTUBE_CHAT_RECONNECT_MS", process.env.YOUTUBE_CHAT_RECONNECT_MS || "5000"],
  ["YOUTUBE_CHAT_IDLE_MS", process.env.YOUTUBE_CHAT_IDLE_MS || "1000"],
  ["WORKER_HEARTBEAT_MS", process.env.WORKER_HEARTBEAT_MS || "15000"]
];

for (let court = 1; court <= env.courtCount; court += 1) {
  const ivs = courtIvsEnv(court);
  const generated = generatedIvs[court];
  vercelLines.push([`COURT_${court}_IVS_CHANNEL_ARN`, ivs.channelArn || generated?.channelArn || ""]);
  vercelLines.push([`COURT_${court}_IVS_PLAYBACK_URL`, ivs.playbackUrl || generated?.playbackUrl || ""]);
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

function readGeneratedIvs() {
  const file = path.join(process.cwd(), ".local", "aws-ivs.generated.json");
  const contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const parsed = contents ? JSON.parse(contents) as { channels?: Array<{ court: number; channelArn?: string; playbackUrl?: string }> } : {};
  return Object.fromEntries((parsed.channels ?? []).map((channel) => [channel.court, channel]));
}
