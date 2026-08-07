import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");
const values = Object.fromEntries([
  "LINOVISION_SNMP_USER",
  "LINOVISION_SNMP_AUTH_PASSWORD",
  "LINOVISION_SNMP_PRIV_PASSWORD"
].map((name) => [name, required(name)]));

await mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, "snmp.env");
await writeFile(outputPath, envFile(values), { encoding: "utf8", mode: 0o600 });
await chmod(outputPath, 0o600);
console.log("Rendered protected SNMP exporter configuration.");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function envFile(record) {
  return Object.entries(record).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join("\n") + "\n";
}
