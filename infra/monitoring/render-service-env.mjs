import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");
const requiredNames = [
  "MONITOR_API_TOKEN",
  "ALERTMANAGER_WEBHOOK_TOKEN",
  "MONITOR_BROWSER_HEARTBEAT_SECRET",
  "MONITOR_AGENT_TARGETS",
  "MONITOR_PUBLIC_HOST"
];
const optionalNames = [
  "HEALTHCHECKS_BASELINE_PING_URL",
  "HEALTHCHECKS_BASELINE_CHECK_ID",
  "HEALTHCHECKS_ACTIVE_PING_URL",
  "HEALTHCHECKS_API_KEY",
  "HEALTHCHECKS_ACTIVE_CHECK_ID",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PUSHOVER_APP_TOKEN",
  "PUSHOVER_USER_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_FROM_NUMBER",
  "TWILIO_TO_NUMBER",
  "YOUTUBE_API_KEY",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN"
];
const values = Object.fromEntries(requiredNames.map((name) => [name, required(name)]));
for (const name of optionalNames) values[name] = process.env[name]?.trim() ?? "";
values.MONITOR_SERVICE_BIND = "0.0.0.0";
values.MONITOR_SERVICE_PORT = process.env.MONITOR_SERVICE_PORT?.trim() || "9110";
values.MONITOR_SERVICE_INTERVAL_MS = process.env.MONITOR_SERVICE_INTERVAL_MS?.trim() || "5000";
values.ALERTMANAGER_INTERNAL_URL = process.env.ALERTMANAGER_INTERNAL_URL?.trim() || "http://alertmanager:9093";
values.MONITOR_COURT_COUNT = process.env.MONITOR_COURT_COUNT?.trim() || "8";
values.MONITOR_BROWSER_ALLOWED_ORIGINS = process.env.MONITOR_BROWSER_ALLOWED_ORIGINS?.trim() || "https://score.beachvolleyballmedia.com";
values.MONITOR_DASHBOARD_URL = process.env.MONITOR_DASHBOARD_URL?.trim() || "https://score.beachvolleyballmedia.com/admin/monitor";
values.HEALTHCHECKS_BASELINE_INTERVAL_MS = process.env.HEALTHCHECKS_BASELINE_INTERVAL_MS?.trim() || "600000";
values.HEALTHCHECKS_ACTIVE_INTERVAL_MS = process.env.HEALTHCHECKS_ACTIVE_INTERVAL_MS?.trim() || "60000";
values.HEALTHCHECKS_CHANNEL_AUDIT_INTERVAL_MS = process.env.HEALTHCHECKS_CHANNEL_AUDIT_INTERVAL_MS?.trim() || "300000";
values.NOTIFICATION_SMS_ESCALATION_MS = process.env.NOTIFICATION_SMS_ESCALATION_MS?.trim() || "120000";
values.NOTIFICATION_STATUS_INTERVAL_MS = process.env.NOTIFICATION_STATUS_INTERVAL_MS?.trim() || "30000";
values.YOUTUBE_MONITOR_INTERVAL_MS = process.env.YOUTUBE_MONITOR_INTERVAL_MS?.trim() || "60000";

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
