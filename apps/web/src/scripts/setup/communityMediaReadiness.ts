import type { AppEnv } from "../../lib/env";

const REQUIRED_WORKER_KEYS = [
  "COMMUNITY_MEDIA_WHEP_BASE_URL",
  "COMMUNITY_MEDIA_READ_USER",
  "COMMUNITY_MEDIA_READ_PASS"
] as const;

type CommunityMediaEnv = Pick<
  AppEnv,
  | "mediamtxWhepBaseUrl"
  | "communityMediaWhepBaseUrl"
  | "communityMediaReadUser"
  | "communityMediaReadPass"
  | "communityMediaMaxPerCourt"
  | "communityMediaMaxTotal"
  | "communityMediaSessionSeconds"
>;

export function communityMediaReadiness(input: {
  env: CommunityMediaEnv;
  rawEnv?: Readonly<Record<string, string | undefined>>;
  workerEnvKeys?: ReadonlySet<string>;
}) {
  const { env } = input;
  const rawEnv = input.rawEnv ?? process.env;
  const issues: string[] = [];

  const edgeUrl = deploymentUrl(env.communityMediaWhepBaseUrl);
  const originUrl = deploymentUrl(env.mediamtxWhepBaseUrl);
  if (!edgeUrl) {
    issues.push("COMMUNITY_MEDIA_WHEP_BASE_URL must be a valid HTTPS capacity-qualified read-edge URL.");
  } else if (edgeUrl.protocol !== "https:") {
    issues.push("COMMUNITY_MEDIA_WHEP_BASE_URL must use HTTPS.");
  }
  if (!originUrl) {
    issues.push("MEDIAMTX_WHEP_BASE_URL must be a valid URL so read-edge isolation can be verified.");
  }
  if (edgeUrl && originUrl && edgeUrl.hostname.toLowerCase() === originUrl.hostname.toLowerCase()) {
    issues.push("COMMUNITY_MEDIA_WHEP_BASE_URL must not share a hostname with the MediaMTX origin.");
  }
  if (!env.communityMediaReadUser.trim()) {
    issues.push("COMMUNITY_MEDIA_READ_USER is required by both the broker and cleanup worker.");
  }
  if (!env.communityMediaReadPass.trim()) {
    issues.push("COMMUNITY_MEDIA_READ_PASS is required by both the broker and cleanup worker.");
  }

  addIntegerIssue({
    issues,
    key: "COMMUNITY_MEDIA_MAX_PER_COURT",
    raw: rawEnv.COMMUNITY_MEDIA_MAX_PER_COURT,
    effective: env.communityMediaMaxPerCourt,
    minimum: 1,
    maximum: 5_000
  });
  addIntegerIssue({
    issues,
    key: "COMMUNITY_MEDIA_MAX_TOTAL",
    raw: rawEnv.COMMUNITY_MEDIA_MAX_TOTAL,
    effective: env.communityMediaMaxTotal,
    minimum: 1,
    maximum: 20_000
  });
  addIntegerIssue({
    issues,
    key: "COMMUNITY_MEDIA_SESSION_SECONDS",
    raw: rawEnv.COMMUNITY_MEDIA_SESSION_SECONDS,
    effective: env.communityMediaSessionSeconds,
    minimum: 30,
    maximum: 600,
    allowMissing: true
  });
  if (env.communityMediaMaxPerCourt > env.communityMediaMaxTotal) {
    issues.push("COMMUNITY_MEDIA_MAX_PER_COURT must not exceed COMMUNITY_MEDIA_MAX_TOTAL.");
  }

  const missingWorkerKeys = input.workerEnvKeys
    ? REQUIRED_WORKER_KEYS.filter((key) => !input.workerEnvKeys?.has(key))
    : [];
  if (missingWorkerKeys.length) {
    issues.push(`Generated worker environment is missing cleanup settings: ${missingWorkerKeys.join(", ")}.`);
  }

  return {
    status: issues.length ? "blocked" as const : "ok" as const,
    issues,
    config: {
      edgeUrlSet: Boolean(env.communityMediaWhepBaseUrl),
      originUrlSet: Boolean(env.mediamtxWhepBaseUrl),
      isolatedHostname: Boolean(edgeUrl && originUrl && edgeUrl.hostname.toLowerCase() !== originUrl.hostname.toLowerCase()),
      readCredentialsSet: Boolean(env.communityMediaReadUser.trim() && env.communityMediaReadPass.trim()),
      maxPerCourt: env.communityMediaMaxPerCourt,
      maxTotal: env.communityMediaMaxTotal,
      sessionSeconds: env.communityMediaSessionSeconds,
      workerCleanupEnvGenerated: input.workerEnvKeys
        ? missingWorkerKeys.length === 0
        : null
    }
  };
}

function deploymentUrl(value: string): URL | null {
  const normalized = value.trim();
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return url.username || url.password || url.search || url.hash ? null : url;
  } catch {
    return null;
  }
}

function addIntegerIssue(input: {
  issues: string[];
  key: string;
  raw: string | undefined;
  effective: number;
  minimum: number;
  maximum: number;
  allowMissing?: boolean;
}) {
  const raw = input.raw?.trim();
  const value = raw ? Number(raw) : input.effective;
  const missingAllowed = input.allowMissing && !raw;
  if (!missingAllowed && (!raw || !Number.isInteger(value) || value < input.minimum || value > input.maximum)) {
    input.issues.push(`${input.key} must be an integer from ${input.minimum} through ${input.maximum}.`);
    return;
  }
  if (missingAllowed) return;
  if (!Number.isInteger(input.effective)
    || input.effective < input.minimum
    || input.effective > input.maximum) {
    input.issues.push(`${input.key} did not resolve to a safe bounded integer.`);
  }
}
