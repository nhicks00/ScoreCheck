import fs from "node:fs";
import path from "node:path";
import { redact } from "./redact";
import { loadLocalEnv } from "../envLoader";

loadLocalEnv();

const apiKey = process.env.STREAMRUN_API_KEY;
const baseUrl = process.env.STREAMRUN_BASE_URL || "https://streamrun.com";
const configurationId = process.env.STREAMRUN_CONFIGURATION_ID;
const outputDir = path.join(process.cwd(), ".local");

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

async function main() {
  if (!apiKey) throw new Error("STREAMRUN_API_KEY is required in .env.setup.local");

  const headers = { authorization: `Bearer ${apiKey}` };
  fs.mkdirSync(outputDir, { recursive: true });

  const [configurations, destinations, configuration] = await Promise.all([
    fetchJson(`${baseUrl}/api/v1/configurations`, headers),
    fetchJson(`${baseUrl}/api/v1/destinations`, headers),
    configurationId ? fetchJson(`${baseUrl}/api/v1/configurations/${configurationId}`, headers) : Promise.resolve(null)
  ]);
  const discovery = { configurations, destinations, configuration };
  fs.writeFileSync(path.join(outputDir, "streamrun-discovery.generated.json"), JSON.stringify(discovery, null, 2));
  fs.writeFileSync(path.join(outputDir, "streamrun-discovery.redacted.json"), JSON.stringify(redact(discovery), null, 2));
  console.log(`Wrote ${path.join(outputDir, "streamrun-discovery.generated.json")}`);
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} failed with ${res.status}`);
  return await res.json();
}
