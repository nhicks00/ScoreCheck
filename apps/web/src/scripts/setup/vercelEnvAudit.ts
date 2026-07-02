import fs from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "../envLoader";

type VercelProjectFile = {
  orgId?: string;
  projectId?: string;
};

type VercelEnv = {
  key: string;
  target?: string | string[];
};

const requiredTargets = ["production", "preview"] as const;
const workerOnlyYoutubeKeys = [
  "YOUTUBE_API_KEY",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
  "YOUTUBE_BOT_POSTING_ENABLED"
];

loadLocalEnv();

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

async function main() {
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is required to audit Vercel environment variables.");

  const project = readProjectFile();
  if (!project.projectId) throw new Error("Missing .vercel/project.json projectId. Run vercel link first.");

  const expectedKeys = parseEnvKeys(path.join(process.cwd(), ".local", "vercel-env.generated.env"));
  const generatedWorkerOnlyKeys = expectedKeys.filter((key) => workerOnlyYoutubeKeys.includes(key));
  const teamQuery = project.orgId ? `?teamId=${encodeURIComponent(project.orgId)}` : "";
  const [projectConfig, envs] = await Promise.all([
    fetchVercelJson<Record<string, unknown>>(`/v9/projects/${encodeURIComponent(project.projectId)}${teamQuery}`, token),
    fetchVercelJson<{ envs?: VercelEnv[] }>(`/v10/projects/${encodeURIComponent(project.projectId)}/env${teamQuery}`, token)
  ]);

  const actualByTarget = new Map<string, Set<string>>();
  for (const env of envs.envs ?? []) {
    for (const target of normalizeTargets(env.target)) {
      const keys = actualByTarget.get(target) ?? new Set<string>();
      keys.add(env.key);
      actualByTarget.set(target, keys);
    }
  }

  const targetAudits = requiredTargets.map((target) => {
    const actualKeys = actualByTarget.get(target) ?? new Set<string>();
    return {
      target,
      expected: expectedKeys.length,
      actual: actualKeys.size,
      missing: expectedKeys.filter((key) => !actualKeys.has(key)),
      workerOnlyPresent: workerOnlyYoutubeKeys.filter((key) => actualKeys.has(key))
    };
  });

  const productionDomain = process.env.VERCEL_PRODUCTION_DOMAIN || "score.beachvolleyballmedia.com";
  const projectAudit = {
    name: String(projectConfig.name ?? ""),
    framework: String(projectConfig.framework ?? ""),
    rootDirectory: String(projectConfig.rootDirectory ?? ""),
    productionDomainPresent: productionAliases(projectConfig).includes(productionDomain)
  };

  const report = {
    project: projectAudit,
    generated: {
      vercelEnvPath: ".local/vercel-env.generated.env",
      expectedKeys: expectedKeys.length,
      workerOnlyYoutubeKeysPresent: generatedWorkerOnlyKeys
    },
    targets: targetAudits
  };

  console.log(JSON.stringify(report, null, 2));

  const failures = [
    projectAudit.framework === "nextjs" ? null : `Vercel framework is ${projectAudit.framework || "missing"}, expected nextjs.`,
    projectAudit.rootDirectory === "apps/web" ? null : `Vercel rootDirectory is ${projectAudit.rootDirectory || "missing"}, expected apps/web.`,
    projectAudit.productionDomainPresent ? null : `Production domain ${productionDomain} is not assigned to the project.`,
    generatedWorkerOnlyKeys.length === 0 ? null : `Generated Vercel env still includes worker-only YouTube keys: ${generatedWorkerOnlyKeys.join(", ")}.`,
    ...targetAudits.flatMap((audit) => [
      audit.missing.length === 0 ? null : `${audit.target} is missing expected env keys: ${audit.missing.join(", ")}.`,
      audit.workerOnlyPresent.length === 0 ? null : `${audit.target} has worker-only YouTube keys in Vercel app env: ${audit.workerOnlyPresent.join(", ")}.`
    ])
  ].filter(Boolean);

  if (failures.length) {
    throw new Error(`Vercel env audit failed:\n- ${failures.join("\n- ")}`);
  }
}

function readProjectFile(): VercelProjectFile {
  const file = path.join(process.cwd(), ".vercel", "project.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as VercelProjectFile;
}

function parseEnvKeys(file: string): string[] {
  if (!fs.existsSync(file)) {
    throw new Error("Missing .local/vercel-env.generated.env. Run npm run setup:vercel-env first.");
  }
  const keys: string[] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator > 0) keys.push(trimmed.slice(0, separator));
  }
  return keys;
}

async function fetchVercelJson<T>(pathAndQuery: string, token: string): Promise<T> {
  const res = await fetch(`https://api.vercel.com${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vercel API ${pathAndQuery} failed with ${res.status}`);
  return json as T;
}

function normalizeTargets(target: VercelEnv["target"]): string[] {
  if (Array.isArray(target)) return target;
  return target ? [target] : [];
}

function productionAliases(projectConfig: Record<string, unknown>): string[] {
  const targets = record(projectConfig.targets);
  const production = record(targets.production);
  const alias = production.alias;
  return Array.isArray(alias) ? alias.filter((value): value is string => typeof value === "string") : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
