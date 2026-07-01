const workerId = process.env.WORKER_ID ?? `youtube-${crypto.randomUUID()}`;
const intervalMs = numberEnv("YOUTUBE_CHAT_IDLE_MS", 1000);
const reconnectMs = numberEnv("YOUTUBE_CHAT_RECONNECT_MS", 5000);

async function main() {
  await loadLocalEnv();
  const { pollYoutubeChatsOnce } = await import("../lib/youtubeChatWorker");
  const { recordHeartbeat } = await import("../lib/poller");
  console.log(`[worker:youtube] starting ${workerId}`);
  await recordHeartbeat(workerId, "youtube-starting");
  while (true) {
    try {
      await pollYoutubeChatsOnce(workerId);
      await sleep(intervalMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : "YouTube worker failed";
      console.error(`[worker:youtube] ${message}`);
      await recordHeartbeat(workerId, "youtube-error", undefined, { message });
      await sleep(reconnectMs);
    }
  }
}

async function loadLocalEnv() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  for (const file of [".env.local", ".env.setup.local"]) {
    const envPath = path.join(process.cwd(), file);
    const contents = await fs.readFile(envPath, "utf8").catch(() => "");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator);
      const value = trimmed.slice(separator + 1).replace(/^['"]|['"]$/g, "");
      process.env[key] ??= value;
    }
  }
}

function numberEnv(key: string, fallback: number) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();

export {};
