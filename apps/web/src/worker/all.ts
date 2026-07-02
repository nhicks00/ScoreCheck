const workerId = process.env.WORKER_ID ?? `all-${crypto.randomUUID()}`;
const activeIntervalMs = numberEnv("WORKER_ACTIVE_INTERVAL_MS", 1_800);
const idleIntervalMs = numberEnv("WORKER_IDLE_INTERVAL_MS", 8_000);
const youtubeIntervalMs = numberEnv("YOUTUBE_CHAT_IDLE_MS", 1000);

async function main() {
  await loadLocalEnv();
  const { pollActiveCourtsOnce, recordHeartbeat } = await import("../lib/poller");
  const { pollYoutubeChatsOnce } = await import("../lib/youtubeChatWorker");
  console.log(`[worker:all] starting ${workerId}`);
  await recordHeartbeat(workerId, "starting");
  let lastYoutubeAt = 0;
  while (true) {
    const started = Date.now();
    try {
      const poller = await pollActiveCourtsOnce({ owner: workerId });
      if (Date.now() - lastYoutubeAt >= youtubeIntervalMs) {
        lastYoutubeAt = Date.now();
        await pollYoutubeChatsOnce(`${workerId}:youtube`);
      }
      const interval = poller.polls > 0 ? activeIntervalMs : idleIntervalMs;
      await sleep(Math.max(250, interval - (Date.now() - started)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Combined worker failed";
      console.error(`[worker:all] ${message}`);
      await recordHeartbeat(workerId, "error", undefined, { message });
      await sleep(idleIntervalMs);
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
