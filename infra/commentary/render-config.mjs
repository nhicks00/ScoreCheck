import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");

export function renderCommentaryConfigs({
  livekitTemplate,
  caddyTemplate,
  apiKey,
  apiSecret,
  publicIp,
  rtcHost,
  turnHost
}) {
  for (const [name, value] of Object.entries({ livekitTemplate, caddyTemplate, apiKey, apiSecret, publicIp, rtcHost, turnHost })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  }
  const livekitConfig = livekitTemplate
    .replaceAll("__LIVEKIT_API_KEY__", JSON.stringify(apiKey))
    .replaceAll("__LIVEKIT_API_SECRET__", JSON.stringify(apiSecret))
    .replaceAll("__TURN_HOST__", JSON.stringify(turnHost));
  const caddyConfig = caddyTemplate
    .replaceAll("__PUBLIC_IP__", publicIp)
    .replaceAll("__RTC_HOST__", rtcHost)
    .replaceAll("__TURN_HOST__", turnHost);
  for (const [name, value] of Object.entries({ livekitConfig, caddyConfig })) {
    if (/__[A-Z0-9_]+__/u.test(value)) throw new Error(`${name} contains an unresolved template value.`);
  }
  return { livekitConfig, caddyConfig };
}

async function main() {
  const rendered = renderCommentaryConfigs({
    livekitTemplate: await readFile(path.join(directory, "livekit.template.yaml"), "utf8"),
    caddyTemplate: await readFile(path.join(directory, "caddy.template.yaml"), "utf8"),
    apiKey: required("LIVEKIT_COMMENTARY_API_KEY"),
    apiSecret: required("LIVEKIT_COMMENTARY_API_SECRET"),
    publicIp: required("LIVEKIT_COMMENTARY_PUBLIC_IP"),
    rtcHost: required("LIVEKIT_COMMENTARY_RTC_HOST"),
    turnHost: required("LIVEKIT_COMMENTARY_TURN_HOST")
  });
  await mkdir(outputDirectory, { recursive: true });
  await writeSecure("livekit.yaml", rendered.livekitConfig);
  await writeFile(path.join(outputDirectory, "caddy.yaml"), rendered.caddyConfig, "utf8");
  console.log(`Rendered LiveKit commentary configuration for ${required("LIVEKIT_COMMENTARY_RTC_HOST")}.`);
}

async function writeSecure(name, content) {
  const outputPath = path.join(outputDirectory, name);
  await writeFile(outputPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(outputPath, 0o600);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
