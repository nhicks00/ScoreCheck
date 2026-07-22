import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const mediaSourcePath = path.join(directory, "mediamtx.template.yml");
const caddySourcePath = path.join(directory, "Caddyfile.template");

export function renderMediaMtxConfigs({ mediaTemplate, caddyTemplate, environment }) {
  const publicIp = required(environment, "MEDIAMTX_PUBLIC_IP");
  const privateIp = privateIpv4(required(environment, "MEDIAMTX_PRIVATE_IP"));
  const publicHost = required(environment, "MEDIAMTX_PUBLIC_HOST");
  const acmeEmail = email(required(environment, "MEDIAMTX_ACME_EMAIL"));
  const contentAnalyzerBindings = exactContentAnalyzerBindings(required(environment, "MEDIAMTX_CONTENT_ANALYZER_BINDINGS"));
  const delayMs = integerInRange(environment.MEDIAMTX_PROGRAM_DELAY_MS ?? "3500", 0, 30_000);
  const browserSources = [];

  let mediaConfig = mediaTemplate
    .replaceAll("__PUBLIC_IP__", JSON.stringify(publicIp))
    .replaceAll("__PRIVATE_IP__", JSON.stringify(privateIp))
    .replaceAll("__PUBLIC_HOST__", JSON.stringify(publicHost))
    .replaceAll("__CONTENT_ANALYZER_USERS__", renderContentAnalyzerUsers(contentAnalyzerBindings))
    .replaceAll("__PROGRAM_DELAY_US__", String(delayMs * 1_000));

  for (let court = 1; court <= 8; court += 1) {
    const rawSource = environment[`MEDIAMTX_COURT_${court}_RAW_SOURCE`]?.trim() || "publisher";
    if (rawSource !== "publisher" && !rawSource.startsWith("srt://")) {
      throw new Error(`MEDIAMTX_COURT_${court}_RAW_SOURCE must be publisher or an srt:// URL.`);
    }
    const browserSource = environment[`MEDIAMTX_COURT_${court}_BROWSER_SOURCE`]?.trim();
    if (!new Set(["raw", "normalized"]).has(browserSource)) {
      throw new Error(`MEDIAMTX_COURT_${court}_BROWSER_SOURCE must be raw or normalized.`);
    }
    browserSources.push(browserSource);
    mediaConfig = mediaConfig
      .replaceAll(`__COURT_${court}_RAW_SOURCE__`, JSON.stringify(rawSource))
      .replaceAll(`__COURT_${court}_PUBLISH_USER__`, JSON.stringify(required(environment, `MEDIAMTX_COURT_${court}_PUBLISH_USER`)))
      .replaceAll(`__COURT_${court}_PUBLISH_PASSWORD__`, JSON.stringify(required(environment, `MEDIAMTX_COURT_${court}_PUBLISH_PASS`)));
  }
  mediaConfig = mediaConfig.replaceAll("__BROWSER_SOURCE_MAP__", browserSources.join(","));

  const caddyConfig = caddyTemplate
    .replaceAll("__PUBLIC_HOST__", publicHost)
    .replaceAll("__ACME_EMAIL__", acmeEmail);
  for (const [name, value] of Object.entries({ mediaConfig, caddyConfig })) {
    if (/__[A-Z0-9_]+__/u.test(value)) throw new Error(`${name} still contains an unresolved placeholder.`);
  }
  return {
    mediaConfig,
    caddyConfig,
    delayMs,
    contentAnalyzerBindingCount: contentAnalyzerBindings.length,
    contentAnalyzerCourtCount: contentAnalyzerBindings.reduce((total, binding) => total + binding.courts.length, 0)
  };
}

async function main() {
  const mediaOutputPath = process.env.MEDIAMTX_CONFIG_OUTPUT
    ? path.resolve(process.env.MEDIAMTX_CONFIG_OUTPUT)
    : path.join(directory, ".generated", "mediamtx.yml");
  const caddyOutputPath = process.env.MEDIAMTX_CADDY_OUTPUT
    ? path.resolve(process.env.MEDIAMTX_CADDY_OUTPUT)
    : path.join(directory, ".generated", "Caddyfile");
  const rendered = renderMediaMtxConfigs({
    mediaTemplate: await readFile(mediaSourcePath, "utf8"),
    caddyTemplate: await readFile(caddySourcePath, "utf8"),
    environment: process.env
  });
  await mkdir(path.dirname(mediaOutputPath), { recursive: true });
  await mkdir(path.dirname(caddyOutputPath), { recursive: true });
  await writeFile(mediaOutputPath, rendered.mediaConfig, { encoding: "utf8", mode: 0o600 });
  await writeFile(caddyOutputPath, rendered.caddyConfig, { encoding: "utf8", mode: 0o644 });
  await chmod(mediaOutputPath, 0o600);
  await chmod(caddyOutputPath, 0o644);
  console.log(`Rendered MediaMTX and TLS proxy configuration (${rendered.delayMs} ms program delay).`);
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function email(value) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) throw new Error("MEDIAMTX_ACME_EMAIL must be a valid email address.");
  return value;
}

function integerInRange(value, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer from ${min} through ${max}, received ${value}.`);
  }
  return parsed;
}

function privateIpv4(value) {
  if (!isPrivateIpv4(value)) throw new Error("MEDIAMTX_PRIVATE_IP must be a private IPv4 address.");
  return value;
}

function exactContentAnalyzerBindings(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("MEDIAMTX_CONTENT_ANALYZER_BINDINGS must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) {
    throw new Error("MEDIAMTX_CONTENT_ANALYZER_BINDINGS must contain one through eight bindings.");
  }
  const bindings = parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== "courts,ip") {
      throw new Error("Every content-analyzer binding must contain only ip and courts.");
    }
    if (!isPrivateIpv4(entry.ip)) {
      throw new Error("Content-analyzer bindings must contain only exact private IPv4 addresses.");
    }
    if (!Array.isArray(entry.courts) || entry.courts.length < 1 || entry.courts.length > 8
      || entry.courts.some((court) => !Number.isInteger(court) || court < 1 || court > 8)
      || new Set(entry.courts).size !== entry.courts.length) {
      throw new Error("Every content-analyzer binding must own a unique nonempty subset of courts 1-8.");
    }
    return { ip: entry.ip, courts: [...entry.courts].sort((left, right) => left - right) };
  });
  if (new Set(bindings.map((entry) => entry.ip)).size !== bindings.length) {
    throw new Error("Content-analyzer binding IP addresses must be unique.");
  }
  const courts = bindings.flatMap((entry) => entry.courts);
  if (courts.length !== 8 || new Set(courts).size !== 8) {
    throw new Error("Content-analyzer bindings must assign every court 1-8 exactly once.");
  }
  return bindings.sort((left, right) => left.courts[0] - right.courts[0]);
}

function isPrivateIpv4(address) {
  if (typeof address !== "string" || isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function renderContentAnalyzerUsers(bindings) {
  return bindings.map((binding) => {
    const alternatives = binding.courts.join("|");
    const path = binding.courts.length === 1
      ? `~^court${alternatives}_raw$`
      : `~^court(${alternatives})_raw$`;
    const normalizedPath = binding.courts.length === 1
      ? `~^court${alternatives}_normalized$`
      : `~^court(${alternatives})_normalized$`;
    return `  - user: any
    ips: ${JSON.stringify([binding.ip])}
    permissions:
      - action: read
        path: ${JSON.stringify(path)}
      - action: publish
        path: ${JSON.stringify(normalizedPath)}`;
  }).join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
