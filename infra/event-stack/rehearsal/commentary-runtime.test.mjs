import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

import { buildCommentaryClientConfig, CommentaryClientManager } from "./commentary-runtime.mjs";
import { createRehearsalSecretMaterial } from "./rehearsal-secrets.mjs";

const require = createRequire(import.meta.url);
const { installPeerConnectionTracker, joinCommentaryPage, verifyLocalMediaCadence } = require("./commentary-browser-worker.cjs");

const material = createRehearsalSecretMaterial({ random: (length) => Buffer.alloc(length, 4) });

test("keeps browser login and page credentials in a protected config outside evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-commentary-config-"));
  const evidence = join(root, "evidence");
  const runtime = join(root, "secrets", "runtime");
  const config = buildCommentaryClientConfig({ court: 4, generationId: "generation-1234", material, programOrigin: "https://isolated.example.com", evidenceDirectory: evidence, runtimeDirectory: runtime });
  assert.equal(config.marker, "scorecheck-rehearsal-generation-1234-commentator-4");
  assert.equal(config.configPath.startsWith(runtime), true);
  assert.equal(config.logPath.startsWith(evidence), true);
  assert.equal(JSON.stringify(config.redacted).includes(material.programPageToken), false);
  assert.equal(JSON.stringify(config.redacted).includes(material.commentatorPasscode), false);
});

test("preflights, starts, adopts, and stops the exact commentary browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-commentary-runtime-"));
  const evidence = join(root, "evidence");
  const runtime = join(root, "secrets", "runtime");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(evidence), mkdir(runtime, { recursive: true })]));
  const config = buildCommentaryClientConfig({ court: 1, generationId: "generation-1234", material, programOrigin: "https://isolated.example.com", evidenceDirectory: evidence, runtimeDirectory: runtime });
  let processLines = "800 unrelated";
  const signals = [];
  let unrefCount = 0;
  const manager = new CommentaryClientManager({
    sleep: async () => {},
    runner: async (command, args) => {
      if (command === "ps") return { code: 0, stdout: processLines, stderr: "" };
      if (args.includes("-encoders")) return { code: 0, stdout: "pcm_s16le", stderr: "" };
      if (args.includes("-filters")) return { code: 0, stdout: "alimiter amix anoisesrc highpass lowpass loudnorm", stderr: "" };
      if (args.includes("--version")) return { code: 0, stdout: "v24.0.0", stderr: "" };
      if (args.includes("--preflight")) return { code: 0, stdout: "playwright chromium ready", stderr: "" };
      if (command === "/usr/bin/say") {
        if (args.join(" ") === "-v ?") return { code: 0, stdout: "Samantha en_US # Hello", stderr: "" };
        assert.deepEqual(args.slice(0, 4), ["-r", "210", "-o", config.speechSeedPath]);
        assert.match(args.at(-1), /ScoreCheck commentary rehearsal/u);
        await writeFile(config.speechSeedPath, "speech", { mode: 0o600 });
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "ffmpeg") {
        assert.equal(config.fixturePath.endsWith("commentary-microphone.wav"), true);
        if (args.includes("-stream_loop")) {
          assert.match(args.join(" "), /-stream_loop -1/u);
          assert.match(args.join(" "), /anoisesrc=color=pink:amplitude=0\.18:sample_rate=48000:seed=20260717/u);
          assert.match(args.join(" "), /highpass=f=180,lowpass=f=7000\[bed\]/u);
          assert.match(args.join(" "), /amix=inputs=2:duration=first:normalize=0,alimiter=limit=0\.95/u);
          assert.match(args.join(" "), /-t 2700 -ar 48000 -c:a pcm_s16le -ac 1/u);
          await writeFile(config.fixturePath, "fixture", { mode: 0o600 });
        } else {
          assert.match(args.join(" "), /highpass=f=100,lowpass=f=8000,loudnorm=I=-20:LRA=7:TP=-3/u);
          assert.match(args.join(" "), /-ar 48000/u);
          await writeFile(config.normalizedSeedPath, "normalized speech", { mode: 0o600 });
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected ${command}`);
    },
    spawnImpl: (_command, args) => {
      assert.equal(args.includes(material.programPageToken), false);
      assert.equal(args.includes(material.commentatorPasscode), false);
      processLines += `\n500 node ${args.join(" ")}`;
      void writeFile(config.readyPath, `${JSON.stringify({ schemaVersion: 1, court: 1, marker: config.marker })}\n`, { mode: 0o600 });
      return { pid: 500, unref: () => { unrefCount += 1; } };
    },
    killImpl: (pid, signal) => { signals.push({ pid, signal }); processLines = processLines.split("\n").filter((line) => !line.startsWith("500 ")).join("\n"); }
  });
  await manager.preflight(config);
  assert.equal((await manager.ensure(config)).pid, 500);
  assert.equal(unrefCount, 1);
  await assert.rejects(stat(config.speechSeedPath), { code: "ENOENT" });
  await assert.rejects(stat(config.normalizedSeedPath), { code: "ENOENT" });
  assert.equal((await stat(config.configPath)).mode & 0o077, 0);
  const protectedConfig = await readFile(config.configPath, "utf8");
  assert.match(protectedConfig, new RegExp(material.commentatorPasscode));
  assert.equal((await manager.ensure(config)).adopted, true);
  await manager.stop({ marker: config.marker });
  assert.deepEqual(signals, [{ pid: -500, signal: "SIGTERM" }]);
  assert.match(processLines, /unrelated/);
});

test("rehearsal commentary uses direct low-latency preview playback", async () => {
  const source = await readFile(new URL(
    "../../../apps/web/src/app/rehearsal/commentary/court/[courtNumber]/RehearsalCommentaryClient.tsx",
    import.meta.url
  ), "utf8");
  assert.match(source, /mode="preview"/);
  assert.match(source, /audioProcessing=\{false\}/);
  assert.doesNotMatch(source, /mode="scoring"/);
});

test("rehearsal commentary disables DTX so the synthetic microphone remains continuously measurable", async () => {
  const source = await readFile(new URL(
    "../../../apps/web/src/app/commentary/court/[courtNumber]/CommentaryAudioClient.tsx",
    import.meta.url
  ), "utf8");
  assert.match(source, /dtx:\s*audioProcessing/u);
  assert.match(source, /echoCancellation:\s*audioProcessing/u);
  assert.match(source, /noiseSuppression:\s*audioProcessing/u);
  assert.match(source, /autoGainControl:\s*false/u);
});

test("retries one transient commentary join only after reloading the isolated page", async () => {
  let liveWaits = 0;
  let reloads = 0;
  let clicks = 0;
  const messages = [];
  const status = locator({ text: "Connecting" });
  const alert = locator({ text: "" });
  const page = {
    reload: async (options) => { reloads += 1; assert.equal(options.waitUntil, "domcontentloaded"); },
    getByRole: () => ({ click: async () => { clicks += 1; } }),
    locator: (selector) => {
      if (selector === ".commentary-audio-panel .status") {
        return {
          ...status,
          filter: () => ({ waitFor: async () => {
            liveWaits += 1;
            if (liveWaits === 1) throw new Error("transient join timeout");
          } })
        };
      }
      if (selector === ".commentary-audio-panel [role=alert]") return alert;
      return { filter: () => ({ waitFor: async () => {} }) };
    }
  };
  const result = await joinCommentaryPage(page, { attempts: 2, timeoutMs: 10, log: (message) => messages.push(message) });
  assert.deepEqual(result, { attempt: 2 });
  assert.equal(reloads, 1);
  assert.equal(clicks, 2);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /status=Connecting; alert=none/u);
});

test("fails closed with bounded safe diagnostics after every commentary join attempt", async () => {
  let reloads = 0;
  const page = {
    reload: async () => { reloads += 1; },
    getByRole: () => ({ click: async () => {} }),
    locator: (selector) => {
      if (selector === ".commentary-audio-panel .status") {
        return { ...locator({ text: "Not joined" }), filter: () => ({ waitFor: async () => { throw new Error("timeout with protected URL"); } }) };
      }
      if (selector === ".commentary-audio-panel [role=alert]") return locator({ text: "Audio room is not ready. Ask the producer to check it." });
      return { filter: () => ({ waitFor: async () => {} }) };
    }
  };
  await assert.rejects(
    () => joinCommentaryPage(page, { attempts: 2, timeoutMs: 10, log: () => {} }),
    /after 2 attempts \(status=Not joined; alert=Audio room is not ready/u
  );
  assert.equal(reloads, 1);
});

test("manager startup deadline covers both bounded browser join attempts", async () => {
  const source = await readFile(new URL("./commentary-runtime.mjs", import.meta.url), "utf8");
  assert.match(source, /const COMMENTARY_READY_POLL_ATTEMPTS = 900;/u);
  assert.match(source, /attempt < COMMENTARY_READY_POLL_ATTEMPTS/u);
});

test("headless commentary disables background throttling and proves local media cadence before readiness", async () => {
  const source = await readFile(new URL("./commentary-browser-worker.cjs", import.meta.url), "utf8");
  for (const flag of [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding"
  ]) assert.match(source, new RegExp(flag));
  assert.match(source, /const localMedia = await verifyLocalMediaCadence\(page\)/u);
  assert.match(source, /outboundPackets < 1 \|\| outboundBytes < 1/u);
  assert.match(source, /audioEnergy <= 0 \|\| sampleDurationSeconds < durationMs/u);
  assert.match(source, /previewAdvanceSeconds < durationMs \/ 1_000 \* 0\.75/u);
  assert.match(source, /finally \{\s*await browser\?\.close\(\)\.catch/u);
});

test("tracks peer connections before page code creates LiveKit transports", async () => {
  let initScript;
  await installPeerConnectionTracker({ addInitScript: async (script) => { initScript = script; } });
  const created = [];
  class FakePeerConnection {
    constructor(value) { this.value = value; created.push(this); }
  }
  globalThis.window = { RTCPeerConnection: FakePeerConnection };
  try {
    initScript();
    const connection = new window.RTCPeerConnection("commentary");
    assert.equal(connection.value, "commentary");
    assert.deepEqual(created, [connection]);
    assert.deepEqual(window.__scorecheckRehearsalPeerConnections, [connection]);
  } finally {
    delete globalThis.window;
  }
});

test("accepts advancing preview and authoritative non-silent microphone RTP cadence", async () => {
  let videoSamples = 0;
  const page = mediaCadencePage({
    currentTime: () => videoSamples++ * 0.1,
    microphoneWidth: () => 12,
    microphoneStats: [
      { audioSources: 1, outboundPackets: 10, outboundBytes: 1000, totalAudioEnergy: 1, totalSamplesDuration: 2 },
      { audioSources: 1, outboundPackets: 30, outboundBytes: 3000, totalAudioEnergy: 3, totalSamplesDuration: 2.04 }
    ]
  });
  const result = await verifyLocalMediaCadence(page, { durationMs: 40, intervalMs: 10 });
  assert.equal(result.samples >= 3, true);
  assert.equal(result.movingMicrophoneSamples, result.samples);
  assert.equal(result.previewAdvanceSeconds >= 0.1, true);
  assert.equal(result.outboundPackets, 20);
  assert.equal(result.audioEnergy, 2);
});

test("accepts headless meter animation lag when RTP and captured audio energy advance", async () => {
  let videoSamples = 0;
  const page = mediaCadencePage({
    currentTime: () => videoSamples++ * 0.1,
    microphoneWidth: () => 0,
    microphoneStats: [
      { audioSources: 1, outboundPackets: 10, outboundBytes: 1000, totalAudioEnergy: 1, totalSamplesDuration: 2 },
      { audioSources: 1, outboundPackets: 30, outboundBytes: 3000, totalAudioEnergy: 3, totalSamplesDuration: 2.04 }
    ]
  });
  const result = await verifyLocalMediaCadence(page, { durationMs: 40, intervalMs: 10 });
  assert.equal(result.movingMicrophoneSamples, 0);
  assert.equal(result.movingMicrophoneSampleRatio, 0);
  assert.equal(result.outboundPackets, 20);
});

test("fails closed when the synthetic microphone is silent despite packet flow", async () => {
  let videoSamples = 0;
  const page = mediaCadencePage({
    currentTime: () => videoSamples++ * 0.1,
    microphoneWidth: () => 0,
    microphoneStats: [
      { audioSources: 1, outboundPackets: 10, outboundBytes: 1000, totalAudioEnergy: 1, totalSamplesDuration: 2 },
      { audioSources: 1, outboundPackets: 30, outboundBytes: 3000, totalAudioEnergy: 1, totalSamplesDuration: 2.04 }
    ]
  });
  await assert.rejects(
    () => verifyLocalMediaCadence(page, { durationMs: 40, intervalMs: 10 }),
    /microphone cadence did not remain active/u
  );
});

function locator({ text }) {
  return { textContent: async () => text };
}

function mediaCadencePage({ currentTime, microphoneWidth, microphoneStats }) {
  let statSample = 0;
  return {
    evaluate: async () => microphoneStats[Math.min(statSample++, microphoneStats.length - 1)],
    locator: (selector) => ({
      evaluate: async () => selector === "video" ? currentTime() : microphoneWidth()
    })
  };
}
