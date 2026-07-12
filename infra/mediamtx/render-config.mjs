import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, "mediamtx.template.yml");
const outputPath = process.env.MEDIAMTX_CONFIG_OUTPUT
  ? path.resolve(process.env.MEDIAMTX_CONFIG_OUTPUT)
  : path.join(directory, ".generated", "mediamtx.yml");

const publishPassword = required("MEDIAMTX_PUBLISH_PASS");
const publicIp = required("MEDIAMTX_PUBLIC_IP");
const publicHost = process.env.MEDIAMTX_PUBLIC_HOST?.trim() || "preview.beachvolleyballmedia.com";
const delayMs = integerInRange(process.env.MEDIAMTX_PROGRAM_DELAY_MS ?? "3500", 0, 30_000);

let config = await readFile(sourcePath, "utf8");
config = config
  .replaceAll("__PUBLISH_PASSWORD__", JSON.stringify(publishPassword))
  .replaceAll("__PUBLIC_IP__", JSON.stringify(publicIp))
  .replaceAll("__PUBLIC_HOST__", JSON.stringify(publicHost))
  .replaceAll("__PROGRAM_DELAY_US__", String(delayMs * 1_000));

if (/__[A-Z0-9_]+__/.test(config)) {
  throw new Error("MediaMTX config still contains an unresolved placeholder.");
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, config, { encoding: "utf8", mode: 0o600 });
await chmod(outputPath, 0o600);
console.log(`Rendered MediaMTX config to ${outputPath} (${delayMs} ms program delay).`);

function required(name) {
  const value = process.env[name]?.trim();
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
