import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");
const apiKey = required("LIVEKIT_COMMENTARY_API_KEY");
const apiSecret = required("LIVEKIT_COMMENTARY_API_SECRET");
const publicIp = required("LIVEKIT_COMMENTARY_PUBLIC_IP");

await mkdir(outputDirectory, { recursive: true });

const livekitTemplate = await readFile(path.join(directory, "livekit.template.yaml"), "utf8");
const livekitConfig = livekitTemplate
  .replaceAll("__LIVEKIT_API_KEY__", JSON.stringify(apiKey))
  .replaceAll("__LIVEKIT_API_SECRET__", JSON.stringify(apiSecret));
await writeSecure("livekit.yaml", livekitConfig);

const caddyTemplate = await readFile(path.join(directory, "caddy.template.yaml"), "utf8");
const caddyConfig = caddyTemplate.replaceAll("__PUBLIC_IP__", publicIp);
await writeFile(path.join(outputDirectory, "caddy.yaml"), caddyConfig, "utf8");

console.log(`Rendered LiveKit commentary configuration for ${publicIp}.`);

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
