#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, open } from "node:fs/promises";
import { isAbsolute, dirname, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const WIDTH = 640;
const HEIGHT = 360;
const FRAME_RATE = 30;
const AUDIO_SAMPLE_RATE = 48_000;
const AUDIO_SAMPLES_PER_FRAME = AUDIO_SAMPLE_RATE / FRAME_RATE;
const MAX_SNAPSHOT_AGE_MS = 15_000;
const MIN_GATE_REMAINING_MS = 120_000;
const SNAPSHOT_INTERVAL_MS = 2_000;
const AUDIT_SAMPLE_INTERVAL_MS = 10_000;
const FFMPEG_CAPABILITY_TIMEOUT_MS = 10_000;
const MAX_CAPABILITY_OUTPUT_BYTES = 1_000_000;

export const TEST_FEED_SCENARIOS = Object.freeze({
  freeze: Object.freeze({ profile: "PROGRAM_CONTENT", expectedIssue: "FULL_BITRATE_VISUAL_FREEZE", mode: "freeze", requiresBrowser: true }),
  black: Object.freeze({ profile: "PROGRAM_CONTENT", expectedIssue: "CAMERA_CONTENT_BLACK", mode: "black", requiresBrowser: true }),
  "camera-silence": Object.freeze({ profile: "PROGRAM_CONTENT", expectedIssue: "CAMERA_AUDIO_SILENT", mode: "silence", requiresBrowser: true }),
  "publisher-loss": Object.freeze({ profile: "RAW_ONLY", expectedIssue: "REQUIRED_RAW_PATH_MISSING", mode: "publisher-loss", requiresBrowser: false })
});

export function baselineReadyInstruction(scenarioName) {
  const scenario = TEST_FEED_SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`Unknown fault scenario: ${scenarioName}`);
  if (scenario.requiresBrowser) {
    return "Open exactly one protected Program viewer and wait for clean video, visual, and camera-audio telemetry. Then arm the PROGRAM_CONTENT gate, start the protected evidence recorder, and enter FAULT.";
  }
  return `Arm one ${scenario.profile} gate, start the protected evidence recorder, and then enter FAULT.`;
}

const ATTENTION_STATES = new Set(["CRITICAL", "DEGRADED", "UNKNOWN"]);

export function parseTestFeedArgs(argv, env = process.env) {
  const options = {
    courtNumber: null,
    scenario: null,
    output: null,
    ffmpegPath: env.FFMPEG_PATH?.trim() || "ffmpeg",
    apiBase: env.MONITOR_API_BASE?.trim() || "https://monitor.beachvolleyballmedia.com"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--court") options.courtNumber = Number(requiredValue(argv, ++index, argument));
    else if (argument === "--scenario") options.scenario = requiredValue(argv, ++index, argument);
    else if (argument === "--output") options.output = requiredValue(argv, ++index, argument);
    else if (argument === "--ffmpeg") options.ffmpegPath = requiredValue(argv, ++index, argument);
    else if (argument === "--api-base") options.apiBase = requiredValue(argv, ++index, argument);
    else if (argument === "--help" || argument === "-h") return null;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.courtNumber) || options.courtNumber < 2 || options.courtNumber > 5) {
    throw new Error("--court must select an unused direct-publisher Camera 2-5 path.");
  }
  if (!Object.hasOwn(TEST_FEED_SCENARIOS, options.scenario)) {
    throw new Error(`--scenario must be one of: ${Object.keys(TEST_FEED_SCENARIOS).join(", ")}.`);
  }
  if (!options.output || !isAbsolute(options.output)) throw new Error("--output must be an absolute protected evidence path.");
  const base = new URL(options.apiBase);
  if (base.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(base.hostname)) {
    throw new Error("Monitor API must use HTTPS unless it is local.");
  }
  if (!options.ffmpegPath || /[\r\n\0]/.test(options.ffmpegPath)) throw new Error("Invalid FFmpeg path.");
  return options;
}

export function startPreflightProblems(snapshot, courtNumber, receivedAtMs = Date.now()) {
  const problems = commonProblems(snapshot, receivedAtMs);
  const court = snapshot?.courts?.find((entry) => entry.courtNumber === courtNumber);
  if (!court) return [...problems, `Camera ${courtNumber} is missing`];
  if (snapshot.faultGates?.length) problems.push("a monitoring fault gate is already armed");
  if (activeIncidents(snapshot).length) problems.push("an active incident already exists");
  if (!expectationOff(court.expectation)) problems.push("the selected camera has a production expectation");
  for (const branch of ["raw", "preview", "program"]) {
    const path = court.paths?.[branch];
    if (path?.ready || (path?.readerCount ?? 0) > 0) problems.push(`the selected ${branch} path is occupied`);
  }
  if (ATTENTION_STATES.has(court.overallState)) problems.push("the selected camera already needs attention");
  for (const peer of snapshot.courts ?? []) {
    if (peer.courtNumber !== courtNumber && ATTENTION_STATES.has(peer.overallState)) {
      problems.push(`peer Camera ${peer.courtNumber} already needs attention`);
    }
  }
  return unique(problems);
}

export function publishingBaselineProblems(snapshot, courtNumber, expectedProtocol, receivedAtMs = Date.now()) {
  const problems = commonProblems(snapshot, receivedAtMs);
  const court = snapshot?.courts?.find((entry) => entry.courtNumber === courtNumber);
  if (!court) return [...problems, `Camera ${courtNumber} is missing`];
  if (snapshot.faultGates?.length) problems.push("a fault gate was armed before the publishing baseline completed");
  if (activeIncidents(snapshot).length) problems.push("an incident opened before fault injection");
  if (!expectationOff(court.expectation)) problems.push("the selected camera expectation changed before the gate was armed");
  problems.push(...rawPathProblems(court, expectedProtocol));
  return unique(problems);
}

export function faultReadyProblems(snapshot, courtNumber, scenarioName, receivedAtMs = Date.now()) {
  const scenario = TEST_FEED_SCENARIOS[scenarioName];
  if (!scenario) return ["unknown fault scenario"];
  const problems = commonProblems(snapshot, receivedAtMs);
  const court = snapshot?.courts?.find((entry) => entry.courtNumber === courtNumber);
  if (!court) return [...problems, `Camera ${courtNumber} is missing`];
  if (activeIncidents(snapshot).length) problems.push("an incident exists before fault injection");
  const gates = snapshot.faultGates ?? [];
  const gate = gates.length === 1 ? gates[0] : null;
  if (!gate || gate.courtNumber !== courtNumber) problems.push("exactly one gate for the selected camera must be armed");
  else {
    if (gate.profile !== scenario.profile) problems.push(`the gate profile must be ${scenario.profile}`);
    const remainingMs = Date.parse(gate.expiresAt) - receivedAtMs;
    if (!Number.isFinite(remainingMs) || remainingMs < MIN_GATE_REMAINING_MS) problems.push("the fault gate has less than two minutes remaining");
  }
  const expectedCoverage = scenario.profile === "PROGRAM_CONTENT" ? "LIVE_MATCH" : "WARMUP";
  if (court.expectation?.coveragePhase !== expectedCoverage || court.expectation?.mediaExpectation !== "REQUIRED") {
    problems.push("the selected camera did not adopt the requested fault-gate expectation");
  }
  const expectedProtocol = courtNumber === 2 ? "RTMP" : "SRT";
  problems.push(...rawPathProblems(court, expectedProtocol));
  if (court.overallState !== "HEALTHY") problems.push("the selected camera is not healthy immediately before fault injection");
  if (scenario.requiresBrowser) problems.push(...contentBaselineProblems(court, scenarioName, receivedAtMs));
  for (const peer of snapshot.courts ?? []) {
    if (peer.courtNumber !== courtNumber && ATTENTION_STATES.has(peer.overallState)) {
      problems.push(`peer Camera ${peer.courtNumber} needs attention`);
    }
  }
  return unique(problems);
}

export function createVideoFrame(mode, frameNumber, width = WIDTH, height = HEIGHT) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width % 2 || height % 2) {
    throw new Error("Synthetic frame dimensions must be positive even integers.");
  }
  const ySize = width * height;
  const chromaSize = ySize / 4;
  const frame = Buffer.alloc(ySize + chromaSize * 2);
  if (mode === "black") {
    frame.fill(16, 0, ySize);
    frame.fill(128, ySize);
    return frame;
  }
  const movingFrame = mode === "normal" || mode === "silence";
  const offset = movingFrame ? (frameNumber * 7) % 192 : 0;
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    const rowPhase = (Math.floor(y / 12) * 11) % 192;
    for (let x = 0; x < width; x += 1) {
      frame[rowOffset + x] = 32 + ((x + rowPhase + offset) % 192);
    }
  }
  frame.fill(96, ySize, ySize + chromaSize);
  frame.fill(176, ySize + chromaSize);
  return frame;
}

export function createAudioChunk(mode, startingSample, sampleCount = AUDIO_SAMPLES_PER_FRAME, sampleRate = AUDIO_SAMPLE_RATE) {
  const chunk = Buffer.alloc(sampleCount * 2 * 2);
  if (mode === "silence") return chunk;
  const amplitude = 2_500;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * (startingSample + sample) / sampleRate) * amplitude);
    const offset = sample * 4;
    chunk.writeInt16LE(value, offset);
    chunk.writeInt16LE(value, offset + 2);
  }
  return chunk;
}

export function publisherConfiguration({ courtNumber, host, user, password }) {
  if (!Number.isInteger(courtNumber) || courtNumber < 2 || courtNumber > 5) throw new Error("Test publisher supports only Camera 2-5.");
  if (!/^[a-zA-Z0-9.-]+$/.test(host ?? "")) throw new Error("MEDIAMTX_PUBLIC_HOST must contain only a host name or IP address.");
  for (const [label, value] of [["publisher user", user], ["publisher password", password]]) {
    if (!/^[a-zA-Z0-9._~+\/=\-]{1,200}$/.test(value ?? "")) throw new Error(`${label} contains an unsupported character.`);
  }
  const outputUrl = courtNumber === 2
    ? `rtmp://${host}:1935/court${courtNumber}_raw?user=${encodeURIComponent(user)}&pass=${encodeURIComponent(password)}`
    : `srt://${host}:8890?mode=caller&streamid=publish:court${courtNumber}_raw:${user}:${password}&pkt_size=1316&latency=2500000`;
  const protocol = courtNumber === 2 ? "RTMP" : "SRT";
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "yuv420p", "-video_size", `${WIDTH}x${HEIGHT}`, "-framerate", String(FRAME_RATE), "-i", "pipe:0",
    "-f", "s16le", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "2", "-i", "pipe:3",
    "-map", "0:v:0", "-map", "1:a:0",
    "-vf", "scale=1280:720:flags=fast_bilinear,format=yuv420p",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main",
    "-r", String(FRAME_RATE), "-g", String(FRAME_RATE), "-keyint_min", String(FRAME_RATE), "-sc_threshold", "0",
    "-b:v", "2500k", "-minrate", "2500k", "-maxrate", "2500k", "-bufsize", "5000k",
    "-x264-params", "nal-hrd=cbr:force-cfr=1",
    "-c:a", "aac", "-b:a", "128k", "-ar", String(AUDIO_SAMPLE_RATE), "-ac", "2"
  ];
  if (protocol === "RTMP") args.push("-flvflags", "no_duration_filesize", "-f", "flv", outputUrl);
  else args.push("-muxdelay", "0", "-f", "mpegts", outputUrl);
  return { protocol, args, outputUrl, secrets: [user, password, outputUrl] };
}

export function ffmpegCapabilityProblems(protocolOutput, encoderOutput, protocol) {
  const requiredProtocol = String(protocol ?? "").toLowerCase();
  if (!new Set(["rtmp", "srt"]).has(requiredProtocol)) throw new Error(`Unsupported publisher protocol ${protocol}.`);
  const protocols = capabilityNames(protocolOutput);
  const encoders = capabilityNames(encoderOutput);
  const problems = [];
  if (!protocols.has(requiredProtocol)) problems.push(`FFmpeg does not support the required ${requiredProtocol.toUpperCase()} protocol`);
  if (!encoders.has("libx264")) problems.push("FFmpeg does not provide the required libx264 encoder");
  if (!encoders.has("aac")) problems.push("FFmpeg does not provide the required AAC encoder");
  return problems;
}

export async function assertFfmpegCapabilities(ffmpegPath, protocol, spawnProcess = spawn) {
  const [protocolOutput, encoderOutput] = await Promise.all([
    captureProcessOutput(ffmpegPath, ["-hide_banner", "-protocols"], spawnProcess),
    captureProcessOutput(ffmpegPath, ["-hide_banner", "-encoders"], spawnProcess)
  ]);
  const problems = ffmpegCapabilityProblems(protocolOutput, encoderOutput, protocol);
  if (problems.length) throw new Error(`FFmpeg capability preflight failed: ${problems.join("; ")}. Use the pinned container runner.`);
}

export class SyntheticPublisher {
  constructor({ ffmpegPath, configuration, onUnexpectedExit }) {
    this.ffmpegPath = ffmpegPath;
    this.configuration = configuration;
    this.onUnexpectedExit = onUnexpectedExit;
    this.mode = "normal";
    this.child = null;
    this.pumpController = null;
    this.pumpPromise = null;
    this.expectedExit = false;
    this.stderr = "";
    this.generation = 0;
    this.failureReportedGeneration = null;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode == null && this.child.signalCode == null);
  }

  setMode(mode) {
    if (!["normal", "freeze", "black", "silence"].includes(mode)) throw new Error(`Unsupported synthetic mode ${mode}.`);
    this.mode = mode;
  }

  async start() {
    if (this.running) return;
    if (this.child) await this.stop();
    this.expectedExit = false;
    this.stderr = "";
    const generation = ++this.generation;
    this.failureReportedGeneration = null;
    const child = spawn(this.ffmpegPath, this.configuration.args, { stdio: ["pipe", "ignore", "pipe", "pipe"] });
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-32_768);
    });
    child.once("error", (error) => {
      this.reportFailure(generation, new Error(`FFmpeg could not start: ${error.code ?? "SPAWN_ERROR"}`));
    });
    child.once("exit", (code, signal) => {
      this.reportFailure(generation, new Error(`FFmpeg exited unexpectedly (${signal ?? code ?? "unknown"}).`));
    });
    const audio = child.stdio[3];
    if (!child.stdin || !audio || typeof audio.write !== "function") throw new Error("FFmpeg media pipes are unavailable.");
    this.pumpController = new AbortController();
    this.pumpPromise = pumpSyntheticMedia(child.stdin, audio, () => this.mode, this.pumpController.signal)
      .catch((error) => {
        if (error?.code !== "EPIPE" && error?.name !== "AbortError") this.reportFailure(generation, error);
      });
    await once(child, "spawn");
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.expectedExit = true;
    this.pumpController?.abort();
    child.stdin?.end();
    const audio = child.stdio[3];
    if (audio && typeof audio.end === "function") audio.end();
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), sleep(5_000)]);
    }
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => undefined);
    }
    await this.pumpPromise?.catch(() => undefined);
    this.child = null;
    this.pumpController = null;
    this.pumpPromise = null;
  }

  sanitizedError() {
    let value = this.stderr;
    for (const secret of this.configuration.secrets) value = value.split(secret).join("[REDACTED]");
    return value.trim().slice(-2_000);
  }

  reportFailure(generation, error) {
    if (this.expectedExit || generation !== this.generation || this.failureReportedGeneration === generation) return;
    this.failureReportedGeneration = generation;
    this.onUnexpectedExit?.(error);
  }
}

function capabilityNames(output) {
  return new Set(String(output ?? "")
    .split(/\r?\n/)
    .flatMap((line) => line.trim().split(/\s+/))
    .filter((value) => /^[a-zA-Z0-9_.-]+$/.test(value)));
}

async function captureProcessOutput(command, args, spawnProcess) {
  const child = spawnProcess(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let settled = false;
  const append = (chunk) => {
    if (output.length >= MAX_CAPABILITY_OUTPUT_BYTES) return;
    output = `${output}${chunk}`.slice(0, MAX_CAPABILITY_OUTPUT_BYTES);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const timer = setTimeout(() => {
    if (!settled) child.kill("SIGKILL");
  }, FFMPEG_CAPABILITY_TIMEOUT_MS);
  try {
    const [code, signal] = await once(child, "exit");
    settled = true;
    if (code !== 0) throw new Error(`FFmpeg capability command failed (${signal ?? code ?? "unknown"}).`);
    return output;
  } catch (error) {
    settled = true;
    if (error?.code === "ENOENT") throw new Error("FFmpeg executable was not found.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function pumpSyntheticMedia(videoStream, audioStream, modeProvider, signal) {
  const frameDurationMs = 1_000 / FRAME_RATE;
  let frameNumber = 0;
  let audioSample = 0;
  let dueAt = performance.now();
  const freezeFrame = createVideoFrame("freeze", 0);
  const blackFrame = createVideoFrame("black", 0);
  while (!signal.aborted) {
    const waitMs = dueAt - performance.now();
    if (waitMs > 0) await sleep(waitMs, undefined, { signal });
    const mode = modeProvider();
    const video = mode === "freeze" ? freezeFrame : mode === "black" ? blackFrame : createVideoFrame(mode, frameNumber);
    const audio = createAudioChunk(mode, audioSample);
    await Promise.all([writeWithBackpressure(videoStream, video), writeWithBackpressure(audioStream, audio)]);
    frameNumber += 1;
    audioSample += AUDIO_SAMPLES_PER_FRAME;
    dueAt += frameDurationMs;
    if (performance.now() - dueAt > 250) dueAt = performance.now() + frameDurationMs;
  }
}

async function writeWithBackpressure(stream, value) {
  if (stream.destroyed || stream.writableEnded) throw Object.assign(new Error("Media pipe closed."), { code: "EPIPE" });
  if (!stream.write(value)) await once(stream, "drain");
}

class ProtectedAuditLog {
  constructor(file) {
    this.file = file;
  }

  static async create(path) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    return new ProtectedAuditLog(await open(path, "wx", 0o600));
  }

  async write(row, sync = false) {
    await this.file.write(`${JSON.stringify(row)}\n`);
    if (sync) await this.file.sync();
  }

  async close() {
    await this.file.close();
  }
}

export class TestFeedController {
  constructor(options, dependencies) {
    this.options = options;
    this.scenario = TEST_FEED_SCENARIOS[options.scenario];
    this.fetchSnapshot = dependencies.fetchSnapshot;
    this.publisher = dependencies.publisher;
    this.audit = dependencies.audit;
    this.phase = "STARTING";
    this.latestSnapshot = null;
    this.stopRequested = false;
    this.watchPromise = null;
    this.safetyReason = null;
    this.publisherRecoveryRunning = false;
    this.publisherRestartAttempts = 0;
    this.abortController = new AbortController();
    this.sleep = dependencies.sleep ?? sleep;
  }

  async start() {
    const initial = await this.fetchSnapshot();
    const problems = startPreflightProblems(initial, this.options.courtNumber);
    if (problems.length) throw new Error(`Start preflight failed: ${problems.join("; ")}`);
    await this.audit.write({ kind: "header", schemaVersion: 1, startedAt: nowIso(), courtNumber: this.options.courtNumber, scenario: this.options.scenario, gateProfile: this.scenario.profile, expectedIssue: this.scenario.expectedIssue }, true);
    await this.publisher.start();
    const baseline = await waitForSnapshot(this.fetchSnapshot, (snapshot, receivedAt) => {
      const result = publishingBaselineProblems(snapshot, this.options.courtNumber, this.publisher.configuration.protocol, receivedAt);
      return result.length === 0;
    }, 45_000, this.abortController.signal);
    this.latestSnapshot = baseline.snapshot;
    this.phase = "BASELINE_READY";
    await this.audit.write({ kind: "transition", transition: "BASELINE_READY", at: new Date(baseline.receivedAt).toISOString(), snapshot: snapshotSummary(baseline.snapshot, this.options.courtNumber) }, true);
    process.stdout.write(`TEST FEED READY: Camera ${this.options.courtNumber} is publishing a healthy synthetic baseline.\n`);
    process.stdout.write(`${baselineReadyInstruction(this.options.scenario)}\n`);
    this.watchPromise = this.watch();
  }

  async command(value) {
    const command = value.trim().toUpperCase();
    if (!command) return false;
    if (command === "HELP") {
      process.stdout.write("Commands: STATUS, FAULT, RECOVER, STOP. STOP is refused until the gate is disarmed and incidents are resolved.\n");
      return false;
    }
    if (command === "STATUS") {
      const snapshot = await this.fetchSnapshot();
      this.latestSnapshot = snapshot;
      process.stdout.write(`${JSON.stringify({ phase: this.phase, ...snapshotSummary(snapshot, this.options.courtNumber) }, null, 2)}\n`);
      return false;
    }
    if (command === "FAULT") {
      await this.injectFault();
      return false;
    }
    if (command === "RECOVER") {
      await this.recover();
      return false;
    }
    if (command === "STOP") {
      await this.safeStop();
      return true;
    }
    throw new Error(`Unknown command ${command}. Enter HELP.`);
  }

  async injectFault() {
    if (this.phase !== "BASELINE_READY" && this.phase !== "RECOVERED") throw new Error(`FAULT is not allowed in phase ${this.phase}.`);
    const snapshot = await this.fetchSnapshot();
    const problems = faultReadyProblems(snapshot, this.options.courtNumber, this.options.scenario);
    if (problems.length) throw new Error(`Fault preflight failed: ${problems.join("; ")}`);
    this.phase = "FAULTED";
    if (this.scenario.mode === "publisher-loss") await this.publisher.stop();
    else this.publisher.setMode(this.scenario.mode);
    await this.audit.write({ kind: "transition", transition: "FAULT_INJECTED", at: nowIso(), expectedIssue: this.scenario.expectedIssue, snapshot: snapshotSummary(snapshot, this.options.courtNumber) }, true);
    process.stdout.write(`FAULT INJECTED: waiting for ${this.scenario.expectedIssue}. Enter RECOVER only after the evidence recorder and phone check have captured the opening state.\n`);
  }

  async recover(automaticReason = null) {
    if (this.phase !== "FAULTED" && !automaticReason) throw new Error(`RECOVER is not allowed in phase ${this.phase}.`);
    if (this.scenario.mode === "publisher-loss") {
      this.publisher.setMode("normal");
      await this.publisher.start();
    } else {
      this.publisher.setMode("normal");
    }
    this.phase = automaticReason ? "SAFETY_HOLD" : "RECOVERING";
    await this.audit.write({ kind: "transition", transition: automaticReason ? "AUTOMATIC_SAFETY_RECOVERY" : "RECOVERY_REQUESTED", at: nowIso(), reason: automaticReason }, true);
    if (automaticReason) {
      this.safetyReason = automaticReason;
      process.stderr.write(`SAFETY HOLD: the feed was restored to normal because ${automaticReason}. Disarm the gate only after raw health returns, then resolve the condition before STOP.\n`);
      return;
    }
    const recovered = await waitForSnapshot(this.fetchSnapshot, (snapshot, receivedAt) => recoveryObserved(snapshot, this.options.courtNumber, this.scenario.expectedIssue, receivedAt), 120_000);
    this.latestSnapshot = recovered.snapshot;
    this.phase = "RECOVERED";
    await this.audit.write({ kind: "transition", transition: "RECOVERY_OBSERVED", at: new Date(recovered.receivedAt).toISOString(), snapshot: snapshotSummary(recovered.snapshot, this.options.courtNumber) }, true);
    process.stdout.write("RECOVERY OBSERVED: keep the healthy feed running until the incident resolves and the operator disarms the gate. Then enter STOP.\n");
  }

  async safeStop() {
    if (!["BASELINE_READY", "RECOVERED", "SAFETY_HOLD"].includes(this.phase)) throw new Error(`STOP is not allowed in phase ${this.phase}.`);
    const snapshot = await this.fetchSnapshot();
    const problems = commonProblems(snapshot, Date.now());
    if ((snapshot.faultGates ?? []).length) problems.push("the fault gate is still armed");
    if (activeIncidents(snapshot).length) problems.push("an active incident still exists");
    if (!recoveryObserved(snapshot, this.options.courtNumber, this.scenario.expectedIssue, Date.now())) problems.push("the selected test feed is not healthy");
    if (problems.length) throw new Error(`Safe stop refused: ${unique(problems).join("; ")}`);
    await this.publisher.stop();
    const retired = await waitForSnapshot(this.fetchSnapshot, (candidate) => {
      const court = selectedCourt(candidate, this.options.courtNumber);
      return !court.paths.raw?.ready && (court.paths.raw?.readerCount ?? 0) === 0;
    }, 30_000);
    this.stopRequested = true;
    this.phase = "STOPPED";
    await this.audit.write({ kind: "summary", status: this.safetyReason ? "SAFETY_HOLD_CLEANED_UP" : "CLEAN_STOP", completedAt: new Date(retired.receivedAt).toISOString(), safetyReason: this.safetyReason, snapshot: snapshotSummary(retired.snapshot, this.options.courtNumber) }, true);
    process.stdout.write("CLEAN STOP: the synthetic publisher retired and the selected raw path is empty.\n");
  }

  async watch() {
    let lastAuditAt = 0;
    let consecutiveErrors = 0;
    while (!this.stopRequested) {
      await sleep(SNAPSHOT_INTERVAL_MS);
      try {
        const receivedAt = Date.now();
        const snapshot = await this.fetchSnapshot();
        consecutiveErrors = 0;
        this.latestSnapshot = snapshot;
        if (receivedAt - lastAuditAt >= AUDIT_SAMPLE_INTERVAL_MS) {
          await this.audit.write({ kind: "sample", at: new Date(receivedAt).toISOString(), phase: this.phase, snapshot: snapshotSummary(snapshot, this.options.courtNumber) });
          lastAuditAt = receivedAt;
        }
        const safetyProblem = watcherSafetyProblem(snapshot, this.options.courtNumber, this.scenario.expectedIssue, this.phase, receivedAt);
        if (safetyProblem && this.phase === "FAULTED") await this.recover(safetyProblem);
        else if (safetyProblem && !this.safetyReason) {
          this.safetyReason = safetyProblem;
          this.phase = "SAFETY_HOLD";
          this.publisher.setMode("normal");
          await this.audit.write({ kind: "transition", transition: "SAFETY_HOLD", at: nowIso(), reason: safetyProblem }, true);
          process.stderr.write(`SAFETY HOLD: ${safetyProblem}.\n`);
        }
      } catch (error) {
        consecutiveErrors += 1;
        await this.audit.write({ kind: "error", at: nowIso(), code: "MONITOR_API_ERROR", consecutiveErrors });
        if (consecutiveErrors >= 3 && this.phase === "FAULTED") await this.recover("the monitor API failed three consecutive checks");
      }
    }
  }

  async publisherFailed(error) {
    if (this.stopRequested || this.phase === "STOPPED" || this.publisherRecoveryRunning) return;
    this.publisherRecoveryRunning = true;
    const phaseAtFailure = this.phase;
    const reason = `the synthetic publisher exited unexpectedly (${safeErrorCode(error)})`;
    this.safetyReason = reason;
    this.phase = "SAFETY_HOLD";
    this.publisher.setMode("normal");
    if (this.publisherRestartAttempts >= 1) {
      await this.audit.write({ kind: "transition", transition: "PUBLISHER_RESTART_LIMIT_REACHED", at: nowIso(), reason }, true).catch(() => undefined);
      await this.publisher.stop().catch(() => undefined);
      this.abortController.abort(new Error("The synthetic publisher exceeded its one-restart containment limit."));
      process.stderr.write("SAFETY HOLD: the synthetic publisher failed again after its single containment restart; it was stopped.\n");
      this.publisherRecoveryRunning = false;
      return;
    }
    this.publisherRestartAttempts += 1;
    await this.audit.write({ kind: "transition", transition: "PUBLISHER_RESTART", at: nowIso(), reason, attempt: this.publisherRestartAttempts }, true).catch(() => undefined);
    try {
      await this.publisher.start();
      await this.sleep(750);
      if (!this.publisher.running) throw new Error("The containment publisher did not remain running.");
      process.stderr.write("SAFETY HOLD: the synthetic publisher exited unexpectedly and was restarted in normal mode. Verify raw health, then disarm and STOP.\n");
      if (phaseAtFailure === "STARTING") {
        this.abortController.abort(new Error("The synthetic publishing baseline was interrupted and is not admissible."));
      }
    } catch (restartError) {
      await this.publisher.stop().catch(() => undefined);
      await this.audit.write({ kind: "transition", transition: "PUBLISHER_RESTART_FAILED", at: nowIso(), reason, code: safeErrorCode(restartError) }, true).catch(() => undefined);
      this.abortController.abort(new Error("The synthetic publisher containment restart failed."));
      process.stderr.write("SAFETY HOLD: the synthetic publisher exited unexpectedly and automatic normal-feed restart failed.\n");
    } finally {
      this.publisherRecoveryRunning = false;
    }
  }

  async containAndStop(reason) {
    if (this.phase === "STOPPED") return;
    this.safetyReason = reason;
    this.phase = "SAFETY_HOLD";
    this.publisher.setMode("normal");
    await this.audit.write({ kind: "transition", transition: "INPUT_LOSS_CONTAINMENT", at: nowIso(), reason }, true).catch(() => undefined);
    let mustHoldNormalFeed = false;
    try {
      const snapshot = await this.fetchSnapshot();
      mustHoldNormalFeed = !snapshot.event && ((snapshot.faultGates ?? []).length > 0 || activeIncidents(snapshot).length > 0);
    } catch {
      mustHoldNormalFeed = this.publisher.running;
    }
    if (!mustHoldNormalFeed) {
      await this.publisher.stop();
      this.stopRequested = true;
      this.phase = "STOPPED";
      return;
    }
    if (!this.publisher.running) await this.publisher.start().catch(() => undefined);
    const containmentDeadline = Date.now() + 35 * 60_000;
    while (Date.now() < containmentDeadline) {
      try {
        const snapshot = await this.fetchSnapshot();
        if (snapshot.event) break;
        const safe = (snapshot.faultGates ?? []).length === 0
          && activeIncidents(snapshot).length === 0
          && recoveryObserved(snapshot, this.options.courtNumber, this.scenario.expectedIssue, Date.now());
        if (safe) break;
      } catch {
        // Keep the restored normal publisher alive until the bounded gate window can expire.
      }
      await sleep(2_000);
    }
    await this.publisher.stop();
    this.stopRequested = true;
    this.phase = "STOPPED";
  }

  async close() {
    this.stopRequested = true;
    await this.watchPromise?.catch(() => undefined);
    await this.publisher.stop();
    await this.audit.close();
  }
}

function contentBaselineProblems(court, scenarioName, receivedAtMs) {
  const problems = [];
  const preview = court.paths?.preview;
  const program = court.paths?.program;
  if (!preview?.ready || (preview.inboundBitrateBps ?? 0) <= 0 || (preview.readerCount ?? 0) < 1) problems.push("the preview dependency is not ready with a reader");
  if (!program?.ready || (program.inboundBitrateBps ?? 0) <= 0 || program.readerCount !== 1) problems.push("the program path must have exactly one active viewer");
  const browser = court.browser;
  const browserAge = browser ? receivedAtMs - Date.parse(browser.receivedAt ?? browser.sampledAt) : Number.POSITIVE_INFINITY;
  if (!browser || !Number.isFinite(browserAge) || browserAge < -5_000 || browserAge > 10_000) problems.push("the Program browser heartbeat is missing or stale");
  else {
    if (browser.video?.state !== "playing" || browser.video?.connectionState !== "connected") problems.push("the Program browser is not playing and connected");
    const fps = browser.video?.framesPerSecond;
    if (typeof fps !== "number" || fps < 25 || fps > 35) problems.push("the Program browser frame rate is outside the clean baseline band");
    if ((browser.video?.packetsLost ?? 0) !== 0) problems.push("the Program browser has RTP packet loss before the fault");
    const visualAge = receivedAtMs - Date.parse(browser.visual?.sampledAt);
    if (!Number.isFinite(visualAge) || visualAge < -5_000 || visualAge > 15_000) problems.push("visual analysis is missing or stale");
    if ((browser.visual?.frozenDurationMs ?? 0) !== 0 || (browser.visual?.blackDurationMs ?? 0) !== 0) problems.push("visual analysis is not clean before the fault");
    if (scenarioName === "camera-silence") {
      if (!browser.commentary?.cameraTrackPresent) problems.push("the camera audio track is missing before the silence fault");
      if (browser.commentary?.secondsSinceCameraAudio == null || browser.commentary.secondsSinceCameraAudio > 5) problems.push("camera audio is already silent before the fault");
    }
  }
  return problems;
}

function rawPathProblems(court, expectedProtocol) {
  const path = court.paths?.raw;
  const problems = [];
  if (!path?.ready) problems.push("the selected raw path is not ready");
  if ((path?.inboundBitrateBps ?? 0) < 500_000) problems.push("the selected raw bitrate is below 500 kbps");
  if (path?.frameErrors !== 0) problems.push("the selected raw path has frame errors");
  if (path?.sourceMode !== "PUSH") problems.push("the selected raw path is not a direct push publisher");
  if (path?.sourceProtocol !== expectedProtocol) problems.push(`the selected raw protocol is not ${expectedProtocol}`);
  if (path?.videoCodec !== "H264" || path?.videoWidth !== 1280 || path?.videoHeight !== 720) problems.push("the synthetic H.264 1280x720 profile is not observed");
  if (path?.audioCodec !== "AAC" || path?.audioSampleRateHz !== 48_000 || path?.audioChannelCount !== 2) problems.push("the synthetic AAC 48 kHz stereo profile is not observed");
  return problems;
}

function commonProblems(snapshot, receivedAtMs) {
  const problems = [];
  const generatedAt = Date.parse(snapshot?.generatedAt);
  const ageMs = receivedAtMs - generatedAt;
  if (!Number.isFinite(ageMs) || ageMs < -5_000 || ageMs > MAX_SNAPSHOT_AGE_MS) problems.push("the monitor snapshot is stale or invalid");
  if (snapshot?.collector?.state !== "HEALTHY" || snapshot.collector.agentsFresh !== snapshot.collector.agentsExpected) problems.push("all monitoring agents are not healthy and fresh");
  if (snapshot?.event) problems.push("a tournament event is active");
  if (snapshot?.notifications?.state !== "HEALTHY" || snapshot.notifications?.pushover?.configured !== true) problems.push("Pushover notification health is not ready");
  if (snapshot?.deadMan?.state !== "HEALTHY" || snapshot.deadMan?.phoneChannel?.state !== "HEALTHY") problems.push("external dead-man monitoring is not healthy");
  return problems;
}

function watcherSafetyProblem(snapshot, courtNumber, expectedIssue, phase, receivedAtMs) {
  const common = commonProblems(snapshot, receivedAtMs);
  if (common.length) return common[0];
  const gates = snapshot.faultGates ?? [];
  if (gates.length > 1 || (gates.length === 1 && gates[0].courtNumber !== courtNumber)) return "an unexpected fault gate appeared";
  if (phase === "FAULTED" && gates.length === 0) return "the selected fault gate ended while the injected fault was active";
  const unexpectedIncident = activeIncidents(snapshot).find((incident) => incident.courtNumber !== courtNumber || incident.issueCode !== expectedIssue);
  if (unexpectedIncident) return `unexpected incident ${unexpectedIncident.issueCode} affected ${unexpectedIncident.courtNumber == null ? "a shared dependency" : `Camera ${unexpectedIncident.courtNumber}`}`;
  const peer = (snapshot.courts ?? []).find((court) => court.courtNumber !== courtNumber && ATTENTION_STATES.has(court.overallState));
  return peer ? `peer Camera ${peer.courtNumber} entered ${peer.overallState}` : null;
}

function recoveryObserved(snapshot, courtNumber, expectedIssue, receivedAtMs) {
  if (commonProblems(snapshot, receivedAtMs).length) return false;
  const court = selectedCourt(snapshot, courtNumber);
  if (rawPathProblems(court, courtNumber === 2 ? "RTMP" : "SRT").length) return false;
  if (court.stages?.some((stage) => stage.issueCode === expectedIssue)) return false;
  if (activeIncidents(snapshot).some((incident) => incident.courtNumber === courtNumber && incident.issueCode === expectedIssue)) return false;
  return true;
}

function snapshotSummary(snapshot, courtNumber) {
  const court = selectedCourt(snapshot, courtNumber);
  const path = (branch) => {
    const value = court.paths?.[branch];
    return value ? { ready: value.ready, readySince: value.readySince, bitrateBps: value.inboundBitrateBps, readers: value.readerCount, frameErrors: value.frameErrors, protocol: value.sourceProtocol, mode: value.sourceMode } : null;
  };
  return {
    generatedAt: snapshot.generatedAt,
    eventActive: Boolean(snapshot.event),
    collector: snapshot.collector,
    notificationState: snapshot.notifications?.state ?? null,
    deadManState: snapshot.deadMan?.state ?? null,
    gate: court.faultGate ? { courtNumber: court.faultGate.courtNumber, profile: court.faultGate.profile, armedAt: court.faultGate.armedAt, expiresAt: court.faultGate.expiresAt } : null,
    court: {
      courtNumber,
      overallState: court.overallState,
      expectation: court.expectation,
      raw: path("raw"),
      preview: path("preview"),
      program: path("program"),
      browser: court.browser ? {
        sampledAt: court.browser.sampledAt,
        receivedAt: court.browser.receivedAt,
        pageLoadedAt: court.browser.pageLoadedAt,
        state: court.browser.video?.state,
        connectionState: court.browser.video?.connectionState,
        fps: court.browser.video?.framesPerSecond,
        packetsLost: court.browser.video?.packetsLost,
        reconnectCount: court.browser.video?.reconnectCount,
        reloadCount: court.browser.video?.reloadCount,
        frozenDurationMs: court.browser.visual?.frozenDurationMs,
        blackDurationMs: court.browser.visual?.blackDurationMs,
        cameraAudioSilenceSeconds: court.browser.commentary?.secondsSinceCameraAudio
      } : null,
      issues: (court.stages ?? []).filter((stage) => stage.issueCode).map((stage) => ({ stage: stage.stage, state: stage.state, issueCode: stage.issueCode }))
    },
    activeIncidents: activeIncidents(snapshot).map((incident) => ({ courtNumber: incident.courtNumber, stage: incident.stage, issueCode: incident.issueCode, status: incident.status })),
    peerStates: (snapshot.courts ?? []).filter((entry) => entry.courtNumber !== courtNumber).map((entry) => ({ courtNumber: entry.courtNumber, overallState: entry.overallState }))
  };
}

async function waitForSnapshot(fetchSnapshot, predicate, timeoutMs, signal = null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Monitoring wait was aborted.");
    const receivedAt = Date.now();
    try {
      const snapshot = await fetchSnapshot();
      if (predicate(snapshot, receivedAt)) return { snapshot, receivedAt };
    } catch (error) {
      lastError = error;
    }
    await sleep(1_000);
  }
  throw new Error(lastError ? `Timed out waiting for monitoring state (${safeErrorCode(lastError)}).` : "Timed out waiting for monitoring state.");
}

async function loadSnapshot(apiBase, token) {
  const response = await fetch(`${apiBase.replace(/\/$/, "")}/v1/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(5_000)
  });
  if (!response.ok) throw new Error(`Monitor API returned HTTP ${response.status}.`);
  return response.json();
}

function activeIncidents(snapshot) {
  return (snapshot?.incidents ?? []).filter((incident) => incident.status !== "resolved");
}

function expectationOff(expectation) {
  return expectation?.coveragePhase === "OFF"
    && expectation.mediaExpectation === "OFF"
    && expectation.broadcastExpectation === "OFF"
    && expectation.commentaryExpectation === "NONE"
    && expectation.scoringExpectation === "NONE";
}

function selectedCourt(snapshot, courtNumber) {
  const court = snapshot?.courts?.find((entry) => entry.courtNumber === courtNumber);
  if (!court) throw new Error(`Camera ${courtNumber} is missing from the monitor snapshot.`);
  return court;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function unique(values) {
  return [...new Set(values)];
}

function nowIso() {
  return new Date().toISOString();
}

function safeErrorCode(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP [0-9]{3}/.test(message)) return message.match(/HTTP [0-9]{3}/)?.[0].replace(" ", "_") ?? "HTTP_ERROR";
  if (/timeout|aborted/i.test(message)) return "TIMEOUT";
  return "OPERATIONAL_ERROR";
}

function usage() {
  return [
    "Usage: MONITOR_API_TOKEN=... MEDIAMTX_PUBLIC_HOST=... MEDIAMTX_COURT_N_PUBLISH_USER=... MEDIAMTX_COURT_N_PUBLISH_PASS=...",
    "  ./infra/monitoring/run-test-feed-fault.mjs --court 2..5 --scenario freeze|black|camera-silence|publisher-loss --output /absolute/protected.jsonl"
  ].join("\n");
}

async function main() {
  const options = parseTestFeedArgs(process.argv.slice(2));
  if (!options) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const token = requiredEnvironment("MONITOR_API_TOKEN");
  const host = requiredEnvironment("MEDIAMTX_PUBLIC_HOST");
  const user = requiredEnvironment(`MEDIAMTX_COURT_${options.courtNumber}_PUBLISH_USER`);
  const password = requiredEnvironment(`MEDIAMTX_COURT_${options.courtNumber}_PUBLISH_PASS`);
  const configuration = publisherConfiguration({ courtNumber: options.courtNumber, host, user, password });
  const audit = await ProtectedAuditLog.create(options.output);
  let controller;
  let closing = false;
  const publisher = new SyntheticPublisher({
    ffmpegPath: options.ffmpegPath,
    configuration,
    onUnexpectedExit: (error) => {
      if (!closing) void controller?.publisherFailed(error);
    }
  });
  try {
    await assertFfmpegCapabilities(options.ffmpegPath, configuration.protocol);
    await audit.write({
      kind: "preflight",
      at: nowIso(),
      ffmpegCapabilities: "VERIFIED",
      protocol: configuration.protocol,
      runner: runnerProvenance(process.env)
    }, true);
    controller = new TestFeedController(options, {
      fetchSnapshot: () => loadSnapshot(options.apiBase, token),
      publisher,
      audit
    });
    await controller.start();
    const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    process.on("SIGINT", () => {
      process.stderr.write("SIGINT received. Use RECOVER, disarm the gate, then STOP; forced termination can create a false camera-loss alert.\n");
    });
    for await (const line of readline) {
      try {
        if (await controller.command(line)) break;
      } catch (error) {
        process.stderr.write(`${error.message}\n`);
      }
    }
    readline.close();
    if (controller.phase !== "STOPPED") throw new Error("Input closed before a clean STOP.");
  } catch (error) {
    if (controller) await controller.containAndStop(error.message);
    await audit.write({ kind: "summary", status: "ABORTED", completedAt: nowIso(), code: safeErrorCode(error), publisherError: publisher.sanitizedError() }, true).catch(() => undefined);
    throw error;
  } finally {
    closing = true;
    if (controller) await controller.close();
    else {
      await publisher.stop();
      await audit.close();
    }
  }
}

function runnerProvenance(environment) {
  const hash = (name) => {
    const value = environment[name];
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
  };
  const imageId = environment.SCORECHECK_TEST_FEED_IMAGE_ID;
  return {
    containerImageId: typeof imageId === "string" && /^sha256:[a-f0-9]{64}$/.test(imageId) ? imageId : null,
    imageSourceSha256: hash("SCORECHECK_TEST_FEED_SOURCE_SHA"),
    wrapperSha256: hash("SCORECHECK_TEST_FEED_WRAPPER_SHA")
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`test-feed fault controller error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
