import fs from "node:fs";
import path from "node:path";
import { loadLocalEnv } from "../envLoader";

type VercelProjectFile = {
  orgId?: string;
  projectId?: string;
};

type VercelEnv = {
  id: string;
  key: string;
  target?: string | string[];
};

const workerOnlyYoutubeKeys = [
  "YOUTUBE_API_KEY",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
  "YOUTUBE_BOT_POSTING_ENABLED"
];
const confirmationValue = "remove-worker-youtube-keys";

loadLocalEnv();

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

async function main() {
  const apply = process.argv.includes("--apply");
  const token = process.env.VERCEL_TOKEN;
  if (!token) throw new Error("VERCEL_TOKEN is required to clean Vercel environment variables.");

  const project = readProjectFile();
  if (!project.projectId) throw new Error("Missing .vercel/project.json projectId. Run vercel link first.");

  const teamQuery = project.orgId ? `?teamId=${encodeURIComponent(project.orgId)}` : "";
  const envs = await fetchVercelJson<{ envs?: VercelEnv[] }>(`/v10/projects/${encodeURIComponent(project.projectId)}/env${teamQuery}`, token);
  const candidates = (envs.envs ?? [])
    .filter((env) => workerOnlyYoutubeKeys.includes(env.key))
    .map((env) => ({
      id: env.id,
      key: env.key,
      targets: normalizeTargets(env.target)
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const report = {
    mode: apply ? "apply" : "dry-run",
    projectId: redactProjectId(project.projectId),
    candidates: candidates.map((candidate) => ({
      id: redactEnvId(candidate.id),
      key: candidate.key,
      targets: candidate.targets
    }))
  };
  console.log(JSON.stringify(report, null, 2));

  if (!apply || candidates.length === 0) return;
  if (process.env.CONFIRM_VERCEL_WORKER_ENV_CLEANUP !== confirmationValue) {
    throw new Error(`Refusing to delete Vercel env records without CONFIRM_VERCEL_WORKER_ENV_CLEANUP=${confirmationValue}.`);
  }

  for (const candidate of candidates) {
    await deleteVercelEnv(project.projectId, candidate.id, project.orgId, token);
    console.log(`Deleted ${candidate.key} (${redactEnvId(candidate.id)}) from targets: ${candidate.targets.join(", ") || "none"}`);
  }
}

function readProjectFile(): VercelProjectFile {
  const file = path.join(process.cwd(), ".vercel", "project.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as VercelProjectFile;
}

async function fetchVercelJson<T>(pathAndQuery: string, token: string): Promise<T> {
  const res = await fetch(`https://api.vercel.com${pathAndQuery}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vercel API ${pathAndQuery} failed with ${res.status}`);
  return json as T;
}

async function deleteVercelEnv(projectId: string, envId: string, teamId: string | undefined, token: string) {
  const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  const res = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env/${encodeURIComponent(envId)}${query}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Vercel env delete failed for ${redactEnvId(envId)} with ${res.status}`);
}

function normalizeTargets(target: VercelEnv["target"]): string[] {
  if (Array.isArray(target)) return target;
  return target ? [target] : [];
}

function redactEnvId(id: string) {
  return `${id.slice(0, 6)}...[redacted]`;
}

function redactProjectId(id: string) {
  return `${id.slice(0, 8)}...[redacted]`;
}
