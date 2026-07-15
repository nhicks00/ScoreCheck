import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const mediaSourcePath = path.join(directory, "mediamtx.template.yml");
const caddySourcePath = path.join(directory, "Caddyfile.template");

export function renderMediaMtxConfigs({ mediaTemplate, caddyTemplate, environment }) {
  const publicIp = required(environment, "MEDIAMTX_PUBLIC_IP");
  const publicHost = required(environment, "MEDIAMTX_PUBLIC_HOST");
  const delayMs = integerInRange(environment.MEDIAMTX_PROGRAM_DELAY_MS ?? "3500", 0, 30_000);

  let mediaConfig = mediaTemplate
    .replaceAll("__PUBLIC_IP__", JSON.stringify(publicIp))
    .replaceAll("__PUBLIC_HOST__", JSON.stringify(publicHost))
    .replaceAll("__PROGRAM_DELAY_US__", String(delayMs * 1_000));

  for (let court = 1; court <= 8; court += 1) {
    const rawSource = environment[`MEDIAMTX_COURT_${court}_RAW_SOURCE`]?.trim() || "publisher";
    if (rawSource !== "publisher" && !rawSource.startsWith("srt://")) {
      throw new Error(`MEDIAMTX_COURT_${court}_RAW_SOURCE must be publisher or an srt:// URL.`);
    }
    mediaConfig = mediaConfig
      .replaceAll(`__COURT_${court}_RAW_SOURCE__`, JSON.stringify(rawSource))
      .replaceAll(`__COURT_${court}_PUBLISH_USER__`, JSON.stringify(required(environment, `MEDIAMTX_COURT_${court}_PUBLISH_USER`)))
      .replaceAll(`__COURT_${court}_PUBLISH_PASSWORD__`, JSON.stringify(required(environment, `MEDIAMTX_COURT_${court}_PUBLISH_PASS`)));
  }

  const caddyConfig = caddyTemplate.replaceAll("__PUBLIC_HOST__", publicHost);
  for (const [name, value] of Object.entries({ mediaConfig, caddyConfig })) {
    if (/__[A-Z0-9_]+__/u.test(value)) throw new Error(`${name} still contains an unresolved placeholder.`);
  }
  return { mediaConfig, caddyConfig, delayMs };
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

function integerInRange(value, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer from ${min} through ${max}, received ${value}.`);
  }
  return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
