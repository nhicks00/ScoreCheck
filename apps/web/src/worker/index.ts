const workerId = process.env.WORKER_ID ?? `render-${crypto.randomUUID()}`;
const activeIntervalMs = numberEnv("WORKER_ACTIVE_INTERVAL_MS", 1_800);
const idleIntervalMs = numberEnv("WORKER_IDLE_INTERVAL_MS", 8_000);

async function main() {
  await loadLocalEnv();
  const { pollActiveCourtsOnce, recordHeartbeat } = await import("../lib/poller");
  const { getWorkerCoverageStatus } = await import("../lib/workerSchedule");
  console.log(`[worker] starting ${workerId}`);
  await recordHeartbeat(workerId, "starting");
  while (true) {
    const started = Date.now();
    try {
      const coverage = await getWorkerCoverageStatus();
      if (!coverage.shouldPoll) {
        await recordHeartbeat(workerId, "sleeping", undefined, {
          reason: coverage.reason,
          today: coverage.today,
          timezone: coverage.timezone,
          nextCheckMs: coverage.sleepMs,
          activeEventCount: coverage.activeEventCount
        });
        await sleep(coverage.sleepMs);
        continue;
      }

      const result = await pollActiveCourtsOnce({ owner: workerId, eventIds: coverage.eventIds });
      // Independent, non-blocking live-chat tick. Fire-and-forget so it never
      // stalls the scoring cadence, and its own errors can never destabilize
      // scoring (see maybeRunChatTick). Only runs on coverage days.
      void maybeRunChatTick();
      const interval = result.polls > 0 ? activeIntervalMs : idleIntervalMs;
      await sleep(Math.max(250, interval - (Date.now() - started)));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Worker polling failed";
      console.error(`[worker] ${message}`);
      await recordHeartbeat(workerId, "error", undefined, { message });
      await sleep(idleIntervalMs);
    }
  }
}

// --- Live-chat monitor tick (independent of scoring) ---------------------
// Cadence is separate from the score poll (YOUTUBE_CHAT_POLL_INTERVAL_MS,
// default 180s). State (budget total, per-court pageTokens, resolved chat ids)
// persists across ticks for the process lifetime. A single in-flight guard
// keeps ticks from overlapping; everything is wrapped so a chat failure only
// logs and never touches the scoring loop.
let chatTickInFlight = false;
let lastChatTickAt = 0;
let chatPollerState: import("../lib/chatPoller").ChatPollerState | null = null;

async function maybeRunChatTick() {
  const { getEnv } = await import("../lib/env");
  if (!getEnv().youtubeChatEnabled) return;
  const { chatPollIntervalMs } = await import("../lib/youtubeChat");
  const now = Date.now();
  if (chatTickInFlight || now - lastChatTickAt < chatPollIntervalMs()) return;
  chatTickInFlight = true;
  lastChatTickAt = now;
  try {
    const { pollEventChatsOnce, createChatPollerState } = await import("../lib/chatPoller");
    chatPollerState = chatPollerState ?? createChatPollerState(now);
    const res = await pollEventChatsOnce({ state: chatPollerState });
    chatPollerState = res.state;
    if (!res.ok) {
      console.log(`[worker] chat tick skipped: ${res.reason}`);
    } else if (res.messagesInserted > 0 || res.budgetExceeded) {
      console.log(
        `[worker] chat tick: +${res.messagesInserted} msg across ${res.courtsPolled}/${res.courtsConsidered} court(s), ` +
        `${res.unitsSpent}u spent, day total ${res.state.budget.unitsSpent}u${res.budgetExceeded ? " (BUDGET REACHED — pausing chat for the day)" : ""}`
      );
    }
  } catch (err) {
    console.error(`[worker] chat tick failed: ${err instanceof Error ? err.message : "unknown error"}`);
  } finally {
    chatTickInFlight = false;
  }
}

async function loadLocalEnv() {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const envPath = path.join(process.cwd(), ".env.local");
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

function numberEnv(key: string, fallback: number) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();

export {};
