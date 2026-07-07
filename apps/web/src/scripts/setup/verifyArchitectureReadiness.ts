import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../../lib/env";
import { getActiveEvent } from "../../lib/eventConfig";
import { supabaseAdmin } from "../../lib/supabase";
import { courtStreamPath, videoConfigured } from "../../lib/video";
import { loadLocalEnv } from "../envLoader";

type Status = "ok" | "warning" | "blocked";

type VercelProjectFile = {
  orgId?: string;
  projectId?: string;
};

type VercelEnv = {
  key: string;
  target?: string | string[];
};

loadLocalEnv();

const expectedCourtCount = Number(process.env.NEXT_PUBLIC_COURT_COUNT || 8);
const workerOnlyYoutubeKeys = [
  "YOUTUBE_API_KEY",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
  "YOUTUBE_BOT_POSTING_ENABLED"
];

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

async function main() {
  const sections = {
    supabase: await supabaseSection(),
    mediaMtx: mediaMtxSection(),
    streamRun: streamRunSection(),
    vercel: await vercelSection(),
    generatedArtifacts: generatedArtifactsSection()
  };

  const blockers = [
    ...sectionIssues(sections.supabase, "Supabase"),
    ...sectionIssues(sections.mediaMtx, "MediaMTX"),
    ...sectionIssues(sections.vercel, "Vercel")
  ];
  const manualFollowUps = [
    ...sectionIssues(sections.streamRun, "StreamRun"),
    ...sectionIssues(sections.generatedArtifacts, "Generated artifacts")
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    status: blockers.length ? "blocked" : manualFollowUps.length ? "warning" : "ok",
    blockers,
    manualFollowUps,
    sections
  };

  const outputDir = path.join(process.cwd(), ".local");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "architecture-readiness.redacted.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (blockers.length) {
    throw new Error(`Architecture readiness blocked:\n- ${blockers.join("\n- ")}`);
  }
}

async function supabaseSection() {
  try {
    const event = await getActiveEvent();
    if (!event) return { status: "blocked" as Status, issues: ["No active event found."] };
    const db = supabaseAdmin();
    const [courts, sources, matches, overlays] = await Promise.all([
      db.from("courts").select("id,court_number,current_match_id,stream_path,youtube_live_chat_id,vbl_court_number,mode").eq("event_id", event.id).order("court_number"),
      db.from("bracket_sources").select("source_url,status,last_error").eq("event_id", event.id),
      db.from("matches").select("id,source_type,api_url").eq("event_id", event.id),
      db.from("overlay_states").select("court_id,court_number,stale,updated_at").eq("event_id", event.id)
    ]);
    for (const result of [courts, sources, matches, overlays]) {
      if (result.error) throw result.error;
    }

    const courtRows = courts.data ?? [];
    const courtIds = courtRows.map((court) => court.id).filter((id): id is string => typeof id === "string");
    const scores = courtIds.length
      ? await db.from("score_states").select("court_id,match_id,source,source_available,source_priority,stale").in("court_id", courtIds)
      : { data: [], error: null };
    if (scores.error) throw scores.error;

    const sourceRows = sources.data ?? [];
    const matchRows = matches.data ?? [];
    const scoreRows = scores.data ?? [];
    const overlayRows = overlays.data ?? [];
    const issues = [
      courtRows.length === expectedCourtCount ? null : `Expected ${expectedCourtCount} courts, found ${courtRows.length}.`,
      courtRows.every((court) => court.current_match_id) ? null : "One or more courts lack a current match.",
      courtRows.every((court) => court.youtube_live_chat_id) ? null : "One or more courts lack YouTube live chat metadata.",
      sourceRows.length >= 2 && sourceRows.every((source) => source.status === "success" && !source.last_error) ? null : "VolleyballLife bracket source discovery is not clean.",
      matchRows.filter((match) => match.source_type === "vbl" && match.api_url).length > 0 ? null : "No VBL matches with API URLs are present.",
      scoreRows.length >= expectedCourtCount ? null : "Missing score state rows.",
      overlayRows.length >= expectedCourtCount ? null : "Missing overlay state rows."
    ].filter(Boolean) as string[];

    return {
      status: issues.length ? "blocked" as Status : "ok" as Status,
      issues,
      event: { slug: event.slug, name: event.name },
      courts: courtRows.map((court) => ({
        courtNumber: court.court_number,
        mode: court.mode,
        hasMatch: Boolean(court.current_match_id),
        streamPath: courtStreamPath(court.court_number, court.stream_path),
        hasYoutubeChat: Boolean(court.youtube_live_chat_id),
        vblCourtNumber: court.vbl_court_number ?? null
      })),
      counts: {
        bracketSources: sourceRows.length,
        vblMatchesWithApiUrl: matchRows.filter((match) => match.source_type === "vbl" && match.api_url).length,
        scoreStates: scoreRows.length,
        overlayStates: overlayRows.length
      }
    };
  } catch (err) {
    return { status: "blocked" as Status, issues: [safeError(err)] };
  }
}

function mediaMtxSection() {
  try {
    const env = getEnv();
    const issues = [
      videoConfigured() ? null : "MEDIAMTX_WHEP_BASE_URL or MEDIAMTX_HLS_BASE_URL must be set for scorer preview playback.",
      env.mediamtxRtmpIngestBase ? null : "MEDIAMTX_RTMP_INGEST_BASE is not set; StreamRun preview destinations cannot be generated.",
      !env.mediamtxWhepBaseUrl || env.mediamtxWhepBaseUrl.startsWith("https://") ? null : "MEDIAMTX_WHEP_BASE_URL is not https; browsers on the https site will block mixed content.",
      !env.mediamtxHlsBaseUrl || env.mediamtxHlsBaseUrl.startsWith("https://") ? null : "MEDIAMTX_HLS_BASE_URL is not https; browsers on the https site will block mixed content."
    ].filter(Boolean) as string[];

    return {
      status: issues.length ? "blocked" as Status : "ok" as Status,
      issues,
      config: {
        whepBaseUrlSet: Boolean(env.mediamtxWhepBaseUrl),
        hlsBaseUrlSet: Boolean(env.mediamtxHlsBaseUrl),
        readCredentialsSet: Boolean(env.mediamtxReadUser && env.mediamtxReadPass),
        rtmpIngestBaseSet: Boolean(env.mediamtxRtmpIngestBase)
      }
    };
  } catch (err) {
    return { status: "blocked" as Status, issues: [safeError(err)] };
  }
}

function streamRunSection() {
  try {
    const file = path.join(process.cwd(), ".local", "streamrun-setup.redacted.json");
    if (!fs.existsSync(file)) {
      return { status: "warning" as Status, issues: ["Missing .local/streamrun-setup.redacted.json. Run setup:streamrun:discover and setup:streamrun."] };
    }
    const setup = JSON.parse(fs.readFileSync(file, "utf8")) as {
      generatedAt?: string;
      summary?: Record<string, number>;
      courts?: Array<{ court: number; gaps?: string[]; elements?: { previewOutput?: string | null } }>;
    };
    const summary = setup.summary ?? {};
    const courtGaps = (setup.courts ?? []).flatMap((court) => (court.gaps ?? []).map((gap) => `Court ${court.court}: ${gap}`));
    const issues = [
      summary.configurationsMapped === expectedCourtCount ? null : `Expected ${expectedCourtCount} mapped StreamRun configurations, found ${summary.configurationsMapped ?? 0}.`,
      summary.youtubeDestinationsMapped === expectedCourtCount ? null : `Expected ${expectedCourtCount} mapped YouTube destinations, found ${summary.youtubeDestinationsMapped ?? 0}.`,
      summary.previewDestinationsMapped === expectedCourtCount ? null : `Expected ${expectedCourtCount} mapped MediaMTX preview destinations, found ${summary.previewDestinationsMapped ?? 0}.`,
      summary.courtsWithHtmlOverlay === expectedCourtCount ? null : `Expected ${expectedCourtCount} HTML overlay mappings, found ${summary.courtsWithHtmlOverlay ?? 0}.`,
      ...(courtGaps.length ? courtGaps : [])
    ].filter(Boolean) as string[];

    return {
      status: issues.length ? "warning" as Status : "ok" as Status,
      issues,
      generatedAt: setup.generatedAt,
      summary,
      courtGaps: setup.courts?.map((court) => ({ court: court.court, gaps: court.gaps ?? [], hasSeparatePreviewOutput: Boolean(court.elements?.previewOutput) })) ?? []
    };
  } catch (err) {
    return { status: "warning" as Status, issues: [safeError(err)] };
  }
}

async function vercelSection() {
  try {
    const token = process.env.VERCEL_TOKEN;
    if (!token) return { status: "blocked" as Status, issues: ["VERCEL_TOKEN is not available."] };
    const project = readVercelProjectFile();
    if (!project.projectId) return { status: "blocked" as Status, issues: ["Missing .vercel/project.json projectId."] };
    const expectedKeys = parseEnvKeys(path.join(process.cwd(), ".local", "vercel-env.generated.env"));
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
    const targetAudits = ["production", "preview"].map((target) => {
      const actualKeys = actualByTarget.get(target) ?? new Set<string>();
      return {
        target,
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
    const issues = [
      projectAudit.framework === "nextjs" ? null : `Vercel framework is ${projectAudit.framework || "missing"}, expected nextjs.`,
      projectAudit.rootDirectory === "apps/web" ? null : `Vercel rootDirectory is ${projectAudit.rootDirectory || "missing"}, expected apps/web.`,
      projectAudit.productionDomainPresent ? null : `Production domain ${productionDomain} is not assigned to Vercel project.`,
      ...targetAudits.flatMap((audit) => [
        audit.missing.length ? `${audit.target} missing env keys: ${audit.missing.join(", ")}.` : null,
        audit.workerOnlyPresent.length ? `${audit.target} has worker-only YouTube keys in Vercel app env: ${audit.workerOnlyPresent.join(", ")}.` : null
      ])
    ].filter(Boolean) as string[];
    return {
      status: issues.length ? "blocked" as Status : "ok" as Status,
      issues,
      project: projectAudit,
      targets: targetAudits
    };
  } catch (err) {
    return { status: "blocked" as Status, issues: [safeError(err)] };
  }
}

function generatedArtifactsSection() {
  const requiredFiles = [
    ".local/streamrun-discovery.redacted.json",
    ".local/streamrun-setup.redacted.json",
    ".local/scorecheck-operations-report.redacted.md",
    ".local/vercel-env.generated.env",
    ".local/worker-env.generated.env",
    ".local/youtube-denver.generated.json"
  ];
  const files = requiredFiles.map((file) => ({ file, exists: fs.existsSync(path.join(process.cwd(), file)) }));
  const issues = files.filter((file) => !file.exists).map((file) => `Missing ${file.file}.`);
  return {
    status: issues.length ? "warning" as Status : "ok" as Status,
    issues,
    files
  };
}

function readVercelProjectFile(): VercelProjectFile {
  const file = path.join(process.cwd(), ".vercel", "project.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as VercelProjectFile;
}

function parseEnvKeys(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")));
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

function sectionIssues(section: { status?: Status; issues?: string[] }, label: string) {
  return section.status === "blocked" || section.status === "warning"
    ? (section.issues ?? []).map((issue) => `${label}: ${issue}`)
    : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeError(err: unknown) {
  const message = err instanceof Error
    ? err.message
    : err && typeof err === "object" && "message" in err && typeof err.message === "string"
      ? err.message
      : "Unknown error";
  return message.replace(/Bearer\s+[A-Za-z0-9_.-]+/g, "Bearer [redacted]");
}
