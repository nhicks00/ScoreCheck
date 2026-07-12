import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");
const requiredNames = [
  "MONITOR_API_TOKEN",
  "ALERTMANAGER_WEBHOOK_TOKEN",
  "MONITOR_AGENT_TARGETS",
  "MONITOR_PUBLIC_HOST"
];
const optionalNames = [
  "HEALTHCHECKS_PING_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PUSHOVER_APP_TOKEN",
  "PUSHOVER_USER_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_TO_NUMBER"
];
const values = Object.fromEntries(requiredNames.map((name) => [name, required(name)]));
for (const name of optionalNames) values[name] = process.env[name]?.trim() ?? "";
values.MONITOR_SERVICE_BIND = "0.0.0.0";
values.MONITOR_SERVICE_PORT = process.env.MONITOR_SERVICE_PORT?.trim() || "9110";
values.MONITOR_SERVICE_INTERVAL_MS = process.env.MONITOR_SERVICE_INTERVAL_MS?.trim() || "5000";
values.MONITOR_COURT_COUNT = process.env.MONITOR_COURT_COUNT?.trim() || "8";
values.HEALTHCHECKS_INTERVAL_MS = process.env.HEALTHCHECKS_INTERVAL_MS?.trim() || "60000";

await mkdir(outputDirectory, { recursive: true });
const outputPath = path.join(outputDirectory, "service.env");
await writeFile(outputPath, envFile(values), { encoding: "utf8", mode: 0o600 });
await chmod(outputPath, 0o600);
console.log("Rendered protected observability service configuration.");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function envFile(record) {
  return Object.entries(record).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join("\n") + "\n";
}
