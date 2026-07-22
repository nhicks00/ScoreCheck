import { spawn } from "node:child_process";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isRetryableDeploymentTransportError } from "./stack-deployer.mjs";

export class HevcNormalizerRuntime {
  constructor({ sshKey, knownHosts, runner = runCommand, sleep = delay }) {
    this.sshKey = requiredPath(sshKey, "SSH key");
    this.knownHosts = requiredPath(knownHosts, "known_hosts");
    this.runner = runner;
    this.sleep = sleep;
  }

  async ensure({ host, court, required, sourceProfile, frameRateMode, mediamtxPrivateHost }) {
    validateCourt(court);
    if (typeof required !== "boolean") throw new Error("normalizer requirement must be boolean");
    let state = await this.#status(host);
    if (!required) {
      if (state !== null) throw new Error(`Camera ${court} direct-H264 compositor retains a normalizer container`);
      return { required: false, running: false, camera: court };
    }
    if (state === null) {
      await this.#remote(host, "cd /opt/compositor && ./start-normalizer.sh");
      state = await this.#status(host);
    }
    validateAssignment({ sourceProfile, frameRateMode, mediamtxPrivateHost });
    validateRunningState(state, court, { sourceProfile, frameRateMode, mediamtxPrivateHost });
    return {
      required: true,
      running: true,
      camera: court,
      sourceProfile,
      frameRateMode,
      mediamtxPrivateHost,
      containerId: state.Id,
      startedAt: state.State.StartedAt,
      restartCount: state.RestartCount
    };
  }

  async #status(host) {
    const result = await this.#remote(host, "cd /opt/compositor && if docker inspect bvm-normalizer >/dev/null 2>&1; then docker inspect bvm-normalizer --format '{{json .}}'; else printf 'null\\n'; fi", { retrySafe: true });
    return parseNormalizerInspect(result.stdout);
  }

  async #remote(host, command, options = {}) {
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host ?? "")) throw new Error("normalizer SSH host must be an IPv4 address");
    const args = [
      "-i", this.sshKey,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${this.knownHosts}`,
      "-o", "ConnectTimeout=10",
      `root@${host}`,
      command
    ];
    const attempts = options.retrySafe === true ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.runner("ssh", args);
      } catch (error) {
        if (attempt === attempts || !isRetryableDeploymentTransportError(error)) throw error;
        await this.sleep(attempt * 2_000);
      }
    }
    throw new Error("normalizer SSH retry loop exited unexpectedly");
  }
}

export function parseNormalizerInspect(raw) {
  let value;
  try { value = JSON.parse(String(raw ?? "").trim() || "null"); }
  catch { throw new Error("normalizer inspect response is invalid JSON"); }
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("normalizer inspect response is invalid");
  if (typeof value.Id !== "string" || !/^[a-f0-9]{12,64}$/u.test(value.Id)) throw new Error("normalizer container id is invalid");
  if (!value.State || typeof value.State.Running !== "boolean" || typeof value.State.StartedAt !== "string") throw new Error("normalizer container state is invalid");
  if (!Number.isInteger(value.RestartCount) || value.RestartCount < 0) throw new Error("normalizer restart count is invalid");
  if (!Array.isArray(value.Config?.Env) || value.Config.Env.some((entry) => typeof entry !== "string" || /[\r\n\0]/u.test(entry))) throw new Error("normalizer environment is invalid");
  return value;
}

function validateRunningState(value, court, assignment) {
  if (!value?.State?.Running) throw new Error(`Camera ${court} HEVC normalizer is not running`);
  if (value.RestartCount !== 0) throw new Error(`Camera ${court} HEVC normalizer restarted ${value.RestartCount} time(s)`);
  const environment = Object.fromEntries(value.Config.Env.map((entry) => {
    const separator = entry.indexOf("=");
    return separator < 1 ? [entry, ""] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const expected = {
    CAMERA_NUMBER: String(court),
    CAMERA_NORMALIZER_ENABLED: "true",
    CAMERA_SOURCE_PATH_MODE: "isolated-hevc-normalizer",
    CAMERA_SOURCE_CODEC: "H265",
    CAMERA_SOURCE_PROFILE: assignment.sourceProfile,
    CAMERA_FRAME_RATE_MODE: assignment.frameRateMode,
    CAMERA_NORMALIZER_INPUT_PATH: `court${court}_raw`,
    CAMERA_NORMALIZER_OUTPUT_PATH: `court${court}_normalized`,
    MEDIAMTX_PRIVATE_HOST: assignment.mediamtxPrivateHost
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (environment[key] !== expectedValue) throw new Error(`Camera ${court} normalizer environment ${key} does not match its assignment`);
  }
}

function validateAssignment({ sourceProfile, frameRateMode, mediamtxPrivateHost }) {
  const validFrameRates = sourceProfile === "PRIORITY_1080P60"
    ? new Set(["60000/1001", "60/1"])
    : new Set(["30000/1001", "30/1"]);
  if (!["CONSTRAINED_1080P30", "STANDARD_1080P30", "PRIORITY_1080P60"].includes(sourceProfile)) throw new Error("normalizer source profile is invalid");
  if (!validFrameRates.has(frameRateMode)) throw new Error("normalizer frame-rate mode does not match its source profile");
  if (!isPrivateIpv4(mediamtxPrivateHost)) throw new Error("normalizer MediaMTX host must be a private IPv4 address");
}

function isPrivateIpv4(value) {
  if (typeof value !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) return false;
  const octets = value.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function validateCourt(court) {
  if (!Number.isInteger(court) || court < 1 || court > 8) throw new Error("normalizer court must be from 1 through 8");
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..") || /[\r\n\0]/u.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

async function runCommand(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise({ code, stdout, stderr });
      else reject(new Error(`${basename(command)} failed with exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(-500)}` : ""}`));
    });
  });
}
