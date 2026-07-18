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

async function verifyLocalMediaCadence(page, { durationMs = 8_000, intervalMs = 250, startupTimeoutMs = 30_000 } = {}) {
  const startupStartedAt = Date.now();
  let finalMicrophone = await readMicrophoneStats(page);
  while (Date.now() - startupStartedAt < startupTimeoutMs) {
    if (hasPublishedMicrophone(finalMicrophone)) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    finalMicrophone = await readMicrophoneStats(page);
  }
  if (!hasPublishedMicrophone(finalMicrophone)) {
    throw cadenceError("rehearsal microphone did not begin sending", {
      outboundPackets: finalMicrophone.outboundPackets,
      outboundBytes: finalMicrophone.outboundBytes,
      audioEnergy: finalMicrophone.totalAudioEnergy,
      sampleDurationSeconds: finalMicrophone.totalSamplesDuration
    }, finalMicrophone);
  }
  const startupWaitMs = Date.now() - startupStartedAt;
  const publication = {
    outboundPackets: finalMicrophone.outboundPackets,
    outboundBytes: finalMicrophone.outboundBytes,
    audioEnergy: finalMicrophone.totalAudioEnergy,
    sampleDurationSeconds: finalMicrophone.totalSamplesDuration
  };
  let previousMicrophone = finalMicrophone;
  const startedAt = Date.now();
  const initialTime = await page.locator("video").evaluate((video) => video.currentTime);
  let maximumAudioSources = previousMicrophone.audioSources;
  const cadence = { outboundPackets: 0, outboundBytes: 0, audioEnergy: 0, sampleDurationSeconds: 0 };
  let movingMicrophoneSamples = 0;
  let samples = 0;
  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const width = await page.locator(".commentary-live-meter span").evaluate((element) => Number.parseFloat(element.style.width || "0"));
    if (Number.isFinite(width) && width >= 1) movingMicrophoneSamples += 1;
    finalMicrophone = await readMicrophoneStats(page);
    const outboundDelta = positiveReportDeltas(previousMicrophone.outboundReports, finalMicrophone.outboundReports, ["packets", "bytes"]);
    const sourceDelta = positiveReportDeltas(previousMicrophone.audioSourceReports, finalMicrophone.audioSourceReports, ["energy", "durationSeconds"]);
    cadence.outboundPackets += outboundDelta.packets;
    cadence.outboundBytes += outboundDelta.bytes;
    cadence.audioEnergy += sourceDelta.energy;
    cadence.sampleDurationSeconds += sourceDelta.durationSeconds;
    maximumAudioSources = Math.max(maximumAudioSources, finalMicrophone.audioSources);
    previousMicrophone = finalMicrophone;
    samples += 1;
  }
  const finalTime = await page.locator("video").evaluate((video) => video.currentTime);
  const previewAdvanceSeconds = finalTime - initialTime;
  if (previewAdvanceSeconds < durationMs / 1_000 * 0.75) throw new Error("rehearsal preview cadence did not remain active");
  if (maximumAudioSources < 1 || finalMicrophone.audioSources < 1 || finalMicrophone.activeMicrophoneConnections < 1) {
    throw cadenceError("rehearsal microphone source statistics are unavailable", cadence, finalMicrophone);
  }
  const movingMicrophoneSampleRatio = samples > 0 ? movingMicrophoneSamples / samples : 0;
  if (movingMicrophoneSampleRatio < 0.75) {
    throw cadenceError("rehearsal microphone cadence did not remain active", {
      ...cadence,
      movingMicrophoneSamples,
      samples,
      movingMicrophoneSampleRatio
    }, finalMicrophone);
  }
  const minimumSampleDurationSeconds = durationMs / 1_000 * 0.75;
  const minimumOutboundPackets = Math.max(1, Math.floor(durationMs / 1_000 * 20));
  if (cadence.outboundPackets < minimumOutboundPackets
    || cadence.outboundBytes < minimumOutboundPackets
    || cadence.audioEnergy <= 0
    || cadence.sampleDurationSeconds < minimumSampleDurationSeconds) {
    throw cadenceError("rehearsal microphone RTP and capture did not remain active", {
      ...cadence,
      minimumOutboundPackets,
      minimumSampleDurationSeconds
    }, finalMicrophone);
  }
  return {
    startupWaitMs,
    publicationOutboundPackets: publication.outboundPackets,
    publicationOutboundBytes: publication.outboundBytes,
    publicationAudioEnergy: publication.audioEnergy,
    publicationSampleDurationSeconds: publication.sampleDurationSeconds,
    durationMs,
    samples,
    movingMicrophoneSamples,
    movingMicrophoneSampleRatio,
    previewAdvanceSeconds,
    maximumAudioSources,
    minimumOutboundPackets,
    minimumSampleDurationSeconds,
    outboundPackets: cadence.outboundPackets,
    outboundBytes: cadence.outboundBytes,
    audioEnergy: cadence.audioEnergy,
    sampleDurationSeconds: cadence.sampleDurationSeconds
  };
}

function hasPublishedMicrophone(stats) {
  if (!stats || stats.activeMicrophoneConnections < 1 || stats.audioSources < 1) return false;
  if (!stats.outboundReports.length || !stats.audioSourceReports.length) return false;
  return stats.outboundPackets > 0
    && stats.outboundBytes > 0
    && stats.totalAudioEnergy > 0
    && stats.totalSamplesDuration > 0;
}

function positiveReportDeltas(previousReports, currentReports, fields) {
  const previous = new Map(previousReports.map((report) => [report.key, report]));
  return currentReports.reduce((totals, report) => {
    const prior = previous.get(report.key);
    for (const field of fields) {
      const delta = prior ? Number(report[field]) - Number(prior[field]) : 0;
      if (Number.isFinite(delta) && delta > 0) totals[field] += delta;
    }
    return totals;
  }, Object.fromEntries(fields.map((field) => [field, 0])));
}

function cadenceError(message, cadence, finalMicrophone) {
  const evidence = {
    activeMicrophoneConnections: finalMicrophone.activeMicrophoneConnections,
    audioSources: finalMicrophone.audioSources,
    outboundReports: finalMicrophone.outboundReports.length,
    audioSourceReports: finalMicrophone.audioSourceReports.length,
    ...cadence
  };
  return new Error(`${message} (${JSON.stringify(evidence)})`);
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
    const result = {
      activeMicrophoneConnections: 0,
      audioSources: 0,
      outboundPackets: 0,
      outboundBytes: 0,
      totalAudioEnergy: 0,
      totalSamplesDuration: 0,
      outboundReports: [],
      audioSourceReports: []
    };
    for (const [connectionIndex, connection] of connections.entries()) {
      const hasLiveMicrophoneSender = !["closed", "failed", "disconnected"].includes(connection.connectionState)
        && connection.getSenders().some((sender) => sender.track?.kind === "audio"
          && sender.track.enabled
          && sender.track.readyState === "live");
      if (!hasLiveMicrophoneSender) continue;
      result.activeMicrophoneConnections += 1;
      const reports = await connection.getStats();
      for (const report of reports.values()) {
        const kind = report.kind ?? report.mediaType;
        if (report.type === "outbound-rtp" && kind === "audio" && report.isRemote !== true) {
          const packets = Number(report.packetsSent ?? 0);
          const bytes = Number(report.bytesSent ?? 0);
          result.outboundPackets += packets;
          result.outboundBytes += bytes;
          result.outboundReports.push({ key: `${connectionIndex}:${report.id}`, packets, bytes });
        }
        if (report.type === "media-source" && kind === "audio") {
          const energy = Number(report.totalAudioEnergy ?? 0);
          const durationSeconds = Number(report.totalSamplesDuration ?? 0);
          result.audioSources += 1;
          result.totalAudioEnergy += energy;
          result.totalSamplesDuration += durationSeconds;
          result.audioSourceReports.push({ key: `${connectionIndex}:${report.id}`, energy, durationSeconds });
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
