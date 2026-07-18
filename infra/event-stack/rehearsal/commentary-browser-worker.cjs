#!/usr/bin/env node

const { chmod, readFile, rename, writeFile } = require("node:fs/promises");
const process = require("node:process");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const playwright = require(options.playwright);
  if (options.preflight) {
    const executable = playwright.chromium.executablePath();
    await require("node:fs/promises").access(executable);
    process.stdout.write("playwright chromium ready\n");
    return;
  }

  const config = JSON.parse(await readFile(options.config, "utf8"));
  let browser;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        `--use-file-for-fake-audio-capture=${config.audioFixturePath}`
      ]
    });
    const context = await browser.newContext({ permissions: ["microphone"], viewport: { width: 1280, height: 900 } });
    await installPeerConnectionTracker(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => process.stderr.write(`page error: ${String(error.message).slice(0, 300)}\n`));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) process.stderr.write(`browser ${message.type()}: ${message.text().slice(0, 300)}\n`);
    });

    const login = await page.request.post(`${config.origin}/api/commentary/login`, {
      form: { passcode: config.commentatorPasscode },
      maxRedirects: 0
    });
    if (login.status() !== 303) throw new Error(`commentary login returned HTTP ${login.status()}`);
    const setCookie = login.headers()["set-cookie"] ?? "";
    const cookieMatch = /^scorecheck_commentary=([^;]+)/.exec(setCookie);
    if (!cookieMatch) throw new Error("commentary login did not return its session cookie");
    await context.addCookies([{
      name: "scorecheck_commentary",
      value: cookieMatch[1],
      url: config.origin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax"
    }]);

    await page.goto(config.pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await joinCommentaryPage(page);
    await page.locator("video").evaluate(async (video) => {
      const started = performance.now();
      while ((video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime <= 0) && performance.now() - started < 30_000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime <= 0) throw new Error("rehearsal preview did not render");
    });
    const localMedia = await verifyLocalMediaCadence(page);
    await writeJsonAtomic(config.readyPath, {
      schemaVersion: 1,
      court: config.court,
      marker: config.marker,
      readyAt: new Date().toISOString(),
      localMedia
    });

    await new Promise((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function verifyLocalMediaCadence(page, { durationMs = 8_000, intervalMs = 250 } = {}) {
  const startedAt = Date.now();
  const initialTime = await page.locator("video").evaluate((video) => video.currentTime);
  const initialMicrophone = await readMicrophoneStats(page);
  let movingMicrophoneSamples = 0;
  let samples = 0;
  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const width = await page.locator(".commentary-live-meter span").evaluate((element) => Number.parseFloat(element.style.width || "0"));
    if (Number.isFinite(width) && width >= 1) movingMicrophoneSamples += 1;
    samples += 1;
  }
  const finalTime = await page.locator("video").evaluate((video) => video.currentTime);
  const finalMicrophone = await readMicrophoneStats(page);
  const previewAdvanceSeconds = finalTime - initialTime;
  const outboundPackets = finalMicrophone.outboundPackets - initialMicrophone.outboundPackets;
  const outboundBytes = finalMicrophone.outboundBytes - initialMicrophone.outboundBytes;
  const audioEnergy = finalMicrophone.totalAudioEnergy - initialMicrophone.totalAudioEnergy;
  const sampleDurationSeconds = finalMicrophone.totalSamplesDuration - initialMicrophone.totalSamplesDuration;
  if (previewAdvanceSeconds < durationMs / 1_000 * 0.75) throw new Error("rehearsal preview cadence did not remain active");
  if (initialMicrophone.audioSources < 1 || finalMicrophone.audioSources < 1) throw new Error("rehearsal microphone source statistics are unavailable");
  if (outboundPackets < 1 || outboundBytes < 1) throw new Error("rehearsal microphone did not send audio packets");
  if (audioEnergy <= 0 || sampleDurationSeconds < durationMs / 1_000 * 0.75) throw new Error("rehearsal microphone cadence did not remain active");
  return {
    durationMs,
    samples,
    movingMicrophoneSamples,
    movingMicrophoneSampleRatio: samples > 0 ? movingMicrophoneSamples / samples : 0,
    previewAdvanceSeconds,
    outboundPackets,
    outboundBytes,
    audioEnergy,
    sampleDurationSeconds
  };
}

async function installPeerConnectionTracker(context) {
  await context.addInitScript(() => {
    const connections = [];
    const NativeRTCPeerConnection = window.RTCPeerConnection;
    class TrackedRTCPeerConnection extends NativeRTCPeerConnection {
      constructor(...args) {
        super(...args);
        connections.push(this);
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", { configurable: true, writable: true, value: TrackedRTCPeerConnection });
    Object.defineProperty(window, "__scorecheckRehearsalPeerConnections", { configurable: false, value: connections });
  });
}

async function readMicrophoneStats(page) {
  return page.evaluate(async () => {
    const connections = Array.isArray(window.__scorecheckRehearsalPeerConnections)
      ? window.__scorecheckRehearsalPeerConnections
      : [];
    const result = { audioSources: 0, outboundPackets: 0, outboundBytes: 0, totalAudioEnergy: 0, totalSamplesDuration: 0 };
    for (const connection of connections) {
      const reports = await connection.getStats();
      for (const report of reports.values()) {
        const kind = report.kind ?? report.mediaType;
        if (report.type === "outbound-rtp" && kind === "audio" && report.isRemote !== true) {
          result.outboundPackets += Number(report.packetsSent ?? 0);
          result.outboundBytes += Number(report.bytesSent ?? 0);
        }
        if (report.type === "media-source" && kind === "audio") {
          result.audioSources += 1;
          result.totalAudioEnergy += Number(report.totalAudioEnergy ?? 0);
          result.totalSamplesDuration += Number(report.totalSamplesDuration ?? 0);
        }
      }
    }
    return result;
  });
}

async function joinCommentaryPage(page, {
  attempts = 2,
  timeoutMs = 60_000,
  log = (message) => process.stderr.write(`${message}\n`)
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error("commentary join attempts are invalid");
  let diagnostic = "status=unknown; alert=none";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    try {
      await page.locator("[data-preview-state]").filter({ hasText: "Preview live" }).waitFor({ timeout: timeoutMs });
      await page.getByRole("button", { name: "Join live audio" }).click({ timeout: timeoutMs });
      await page.locator(".commentary-audio-panel .status").filter({ hasText: "Live" }).waitFor({ timeout: timeoutMs });
      return { attempt };
    } catch {
      diagnostic = await commentaryJoinDiagnostic(page);
      log(`commentary join attempt ${attempt}/${attempts} did not become live (${diagnostic})`);
    }
  }
  throw new Error(`commentary audio did not become live after ${attempts} attempts (${diagnostic})`);
}

async function commentaryJoinDiagnostic(page) {
  const status = await safeText(page.locator(".commentary-audio-panel .status"));
  const alert = await safeText(page.locator(".commentary-audio-panel [role=alert]"));
  return `status=${status || "missing"}; alert=${alert || "none"}`;
}

async function safeText(locator) {
  try {
    return String(await locator.textContent() ?? "").replace(/\s+/gu, " ").trim().slice(0, 160);
  } catch {
    return "";
  }
}

function parseArgs(args) {
  const result = { preflight: false, marker: null, config: null, playwright: null };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--preflight") result.preflight = true;
    else if (["--marker", "--config", "--playwright"].includes(value)) result[value.slice(2)] = args[++index];
    else throw new Error(`unsupported commentary browser option ${value}`);
  }
  if (!result.playwright || (!result.preflight && (!result.marker || !result.config))) throw new Error("commentary browser arguments are incomplete");
  return result;
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`commentary browser failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { installPeerConnectionTracker, joinCommentaryPage, readMicrophoneStats, verifyLocalMediaCadence };
