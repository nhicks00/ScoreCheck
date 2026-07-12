import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.join(directory, ".generated");
const targets = parseTargets(process.env.MONITOR_AGENT_TARGETS ?? "");
const monitorToken = required("MONITOR_API_TOKEN");
const alertmanagerToken = required("ALERTMANAGER_WEBHOOK_TOKEN");

const scrapeJobs = targets.map((target) => {
  const url = new URL(target.url);
  return `  - job_name: ${yaml(`agent-${target.id}`)}
    scheme: ${yaml(url.protocol.slice(0, -1))}
    metrics_path: ${yaml(`${url.pathname.replace(/\/$/, "")}/metrics` || "/metrics")}
    authorization:
      type: Bearer
      credentials: ${yaml(target.token)}
    static_configs:
      - targets: [${yaml(url.host)}]
        labels:
          agent: ${yaml(target.id)}
          role: ${yaml(target.role)}`;
}).join("\n");

const prometheus = `global:
  scrape_interval: 5s
  evaluation_interval: 5s
  external_labels:
    system: scorecheck

rule_files:
  - /etc/prometheus/rules/*.rules.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: [alertmanager:9093]

scrape_configs:
  - job_name: monitor-service
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials: ${yaml(monitorToken)}
    static_configs:
      - targets: [monitor-service:9110]

  - job_name: observability-node
    static_configs:
      - targets: [node-exporter:9100]
${scrapeJobs ? `\n${scrapeJobs}` : ""}
`;

const alertmanager = `global:
  resolve_timeout: 2m

route:
  receiver: monitor-service
  group_by: [alertname, root_dependency, host, court]
  group_wait: 5s
  group_interval: 30s
  repeat_interval: 15m

receivers:
  - name: monitor-service
    webhook_configs:
      - url: http://monitor-service:9110/v1/alertmanager
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials: ${yaml(alertmanagerToken)}
`;

await mkdir(outputDirectory, { recursive: true });
await writeSecure("prometheus.yml", prometheus);
await writeSecure("alertmanager.yml", alertmanager);
console.log(`Rendered monitoring configuration for ${targets.length} agent target(s).`);

async function writeSecure(name, content) {
  const outputPath = path.join(outputDirectory, name);
  await writeFile(outputPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(outputPath, 0o600);
}

function parseTargets(raw) {
  if (!raw.trim()) return [];
  return raw.split(",").map((entry) => {
    const [id, role, url, token, courtList, ...extra] = entry.split("|").map((value) => value.trim());
    if (extra.length || courtList == null || !safeId(id) || !safeId(role) || !url || !token || token.length < 24) throw new Error("Invalid MONITOR_AGENT_TARGETS entry.");
    const assignedCourts = parseCourts(courtList);
    if (role === "compositor" && assignedCourts.length === 0) throw new Error("Compositor target has no court assignment.");
    if (role !== "compositor" && assignedCourts.length > 0) throw new Error("Non-compositor target has a court assignment.");
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Agent target must use HTTP(S).");
    return { id, role, url: parsed.toString(), token, assignedCourts };
  });
}

function parseCourts(raw) {
  if (!raw) return [];
  const courts = raw.split("+").map(Number);
  if (courts.some((court) => !Number.isInteger(court) || court < 1 || court > 8)) throw new Error("Invalid target court assignment.");
  return [...new Set(courts)];
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function safeId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value);
}

function yaml(value) {
  return JSON.stringify(String(value));
}
