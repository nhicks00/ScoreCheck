import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../../lib/env";
import { courtStreamPath } from "../../lib/video";
import { loadLocalEnv } from "../envLoader";
import { redact } from "./redact";

type StreamRunElement = {
  id: string;
  type: string;
  title?: string;
  settings?: Record<string, unknown>;
};

type StreamRunConfiguration = {
  id: string;
  name: string;
  elements?: StreamRunElement[] | Record<string, StreamRunElement>;
};

type StreamRunDestination = {
  id: string;
  name: string;
  platform: string;
};

type MediaMtxIngest = {
  streamPath: string;
  rtmpServerUrl: string;
  streamKeyValue: string;
};

loadLocalEnv();

const outputDir = path.join(process.cwd(), ".local");
const discoveryPath = path.join(outputDir, "streamrun-discovery.generated.json");
const env = getEnv();
const publicSiteUrl = env.publicSiteUrl.replace(/\/$/, "");
const rtmpIngestBase = env.mediamtxRtmpIngestBase.trim().replace(/\/+$/, "");
const publishUser = process.env.MEDIAMTX_PUBLISH_USER ?? "";
const publishPass = process.env.MEDIAMTX_PUBLISH_PASS ?? "";

main();

function main() {
  if (!fs.existsSync(discoveryPath)) {
    throw new Error("Run npm run setup:streamrun:discover before setup:streamrun");
  }

  const discovery = JSON.parse(fs.readFileSync(discoveryPath, "utf8")) as {
    configurations?: { configurations?: StreamRunConfiguration[] };
    destinations?: { destinations?: StreamRunDestination[] };
  };
  const configurations = discovery.configurations?.configurations ?? [];
  const destinations = discovery.destinations?.destinations ?? [];

  const courts = Array.from({ length: env.courtCount }, (_, index) => {
    const court = index + 1;
    const configuration = findStreamConfiguration(configurations, court);
    const elements = configuration ? normalizeElements(configuration.elements) : [];
    const input = elements.find((element) => element.type === "inputstream")?.id ?? null;
    const htmlOverlayElement = elements.find((element) => element.type === "htmloverlay") ?? null;
    const htmlOverlay = htmlOverlayElement?.id ?? null;
    const outputElements = elements.filter((element) => element.type === "outputstream");
    const outputs = outputElements.map((element) => element.id);
    const youtubeOutputElement = outputElements[0] ?? null;
    const previewOutputElement = outputElements[1] ?? null;
    const youtubeOutput = youtubeOutputElement?.id ?? null;
    const previewOutput = previewOutputElement?.id ?? null;
    const youtubeDestination = findYoutubeDestination(destinations, court);
    const previewDestination = findPreviewDestination(destinations, court);
    const mediamtx = mediaMtxIngestForCourt(court);
    const overlayUrl = `${publicSiteUrl}/overlay/stream/${court}`;
    const expectedYoutubeDestinations = youtubeOutput && youtubeDestination
      ? [
        youtubeDestination.id,
        ...(!previewOutput && previewDestination ? [previewDestination.id] : [])
      ]
      : [];
    const expectedPreviewDestinations = previewOutput && previewDestination ? [previewDestination.id] : [];
    const launchOverrides: Record<string, unknown> = {};
    if (htmlOverlay) launchOverrides[htmlOverlay] = { url: overlayUrl, visible: true };
    if (youtubeOutput && youtubeDestination) {
      launchOverrides[youtubeOutput] = {
        destinations: expectedYoutubeDestinations
      };
    }
    if (previewOutput && previewDestination) launchOverrides[previewOutput] = { destinations: expectedPreviewDestinations };
    return {
      court,
      configurationId: configuration?.id ?? null,
      configurationName: configuration?.name ?? null,
      elements: {
        input,
        htmlOverlay,
        youtubeOutput,
        previewOutput,
        outputCount: outputs.length
      },
      savedSettings: {
        overlayUrl: typeof htmlOverlayElement?.settings?.url === "string" ? htmlOverlayElement.settings.url : null,
        youtubeDestinations: stringArraySetting(youtubeOutputElement?.settings?.destinations),
        previewDestinations: stringArraySetting(previewOutputElement?.settings?.destinations)
      },
      expectedSettings: {
        overlayUrl,
        youtubeDestinations: expectedYoutubeDestinations,
        previewDestinations: expectedPreviewDestinations
      },
      destinations: {
        youtube: youtubeDestination ? pickDestination(youtubeDestination) : null,
        mediaMtxPreview: previewDestination ? pickDestination(previewDestination) : null
      },
      overlayUrl,
      mediamtx,
      launchRequest: configuration ? {
        configurationId: configuration.id,
        body: {
          numberOfInstances: 1,
          autoStop: true,
          instanceSettings: [{
            name: `AVP Denver Court ${court}`,
            overrides: launchOverrides
          }]
        }
      } : null,
      fallbackMode: !previewOutput && youtubeOutput && previewDestination ? "combined-youtube-and-preview-output" : null,
      gaps: gaps({
        configuration,
        input,
        htmlOverlay,
        youtubeOutput,
        previewOutput,
        youtubeDestination,
        previewDestination,
        mediamtx,
        savedOverlayUrl: typeof htmlOverlayElement?.settings?.url === "string" ? htmlOverlayElement.settings.url : null,
        expectedOverlayUrl: overlayUrl,
        savedYoutubeDestinations: stringArraySetting(youtubeOutputElement?.settings?.destinations),
        expectedYoutubeDestinations,
        savedPreviewDestinations: stringArraySetting(previewOutputElement?.settings?.destinations),
        expectedPreviewDestinations
      })
    };
  });

  const separatePreviewOutputCount = courts.filter((court) => court.elements.previewOutput).length;
  const setup = {
    generatedAt: new Date().toISOString(),
    baseUrl: process.env.STREAMRUN_BASE_URL || "https://streamrun.com",
    mode: "one-configuration-per-court",
    mediaMtxRtmpIngestBase: rtmpIngestBase || null,
    courts,
    summary: {
      configurationsMapped: courts.filter((court) => court.configurationId).length,
      youtubeDestinationsMapped: courts.filter((court) => court.destinations.youtube).length,
      previewDestinationsMapped: courts.filter((court) => court.destinations.mediaMtxPreview).length,
      courtsWithHtmlOverlay: courts.filter((court) => court.elements.htmlOverlay).length,
      courtsWithSeparatePreviewOutput: separatePreviewOutputCount,
      courtsWithMediaMtxPasteValues: courts.filter((court) => court.mediamtx?.rtmpServerUrl && court.mediamtx?.streamKeyValue).length,
      courtsWithSavedOverlayUrl: courts.filter((court) => court.savedSettings.overlayUrl === court.expectedSettings.overlayUrl).length,
      courtsWithSavedYoutubeOutput: courts.filter((court) => sameStringArray(court.savedSettings.youtubeDestinations, court.expectedSettings.youtubeDestinations)).length,
      courtsWithSavedPreviewOutput: courts.filter((court) => sameStringArray(court.savedSettings.previewDestinations, court.expectedSettings.previewDestinations)).length
    },
    notes: streamRunNotes(separatePreviewOutputCount, env.courtCount)
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "streamrun-setup.generated.json"), JSON.stringify(setup, null, 2));
  fs.writeFileSync(path.join(outputDir, "streamrun-setup.redacted.json"), JSON.stringify(redact(setup), null, 2));
  fs.writeFileSync(path.join(outputDir, "streamrun-paste-sheet.generated.md"), pasteSheet(courts));
  fs.writeFileSync(path.join(outputDir, "streamrun-paste-sheet.redacted.md"), pasteSheet(courts, true));
  fs.writeFileSync(path.join(outputDir, "scorecheck-operations-report.redacted.md"), operationsReport(setup));
  console.log(`Wrote ${path.join(outputDir, "streamrun-setup.generated.json")}`);
  console.log(`Wrote ${path.join(outputDir, "streamrun-paste-sheet.generated.md")}`);
  console.log(`Wrote ${path.join(outputDir, "scorecheck-operations-report.redacted.md")}`);
}

function mediaMtxIngestForCourt(court: number): MediaMtxIngest | null {
  if (!rtmpIngestBase) return null;
  const streamPath = courtStreamPath(court);
  const credentials = publishUser && publishPass
    ? `?user=${encodeURIComponent(publishUser)}&pass=${encodeURIComponent(publishPass)}`
    : "";
  return {
    streamPath,
    rtmpServerUrl: `${rtmpIngestBase}/`,
    streamKeyValue: `${streamPath}${credentials}`
  };
}

function streamRunNotes(separatePreviewOutputCount: number, courtCount: number) {
  const notes = [
    "StreamRun preview destinations must be custom RTMP destinations that publish to the MediaMTX droplet ingest (see docs/MEDIAMTX_DIGITALOCEAN_SETUP.md).",
    "Launch requests include YouTube destination, MediaMTX preview destination, and HTML overlay overrides only when those IDs are mapped.",
    "Set MEDIAMTX_RTMP_INGEST_BASE plus MEDIAMTX_PUBLISH_USER/MEDIAMTX_PUBLISH_PASS locally before generating the paste sheet so it includes complete publish values."
  ];

  if (separatePreviewOutputCount === 0) {
    notes.splice(1, 0,
      "No StreamRun workflows expose a separate preview outputstream; launch requests attach MediaMTX preview destinations to the same outputstream as a fallback.",
      "Add a separate preview output branch in the editor later if a clean no-overlay MediaMTX preview path is required."
    );
  } else if (separatePreviewOutputCount < courtCount) {
    notes.splice(1, 0,
      `${separatePreviewOutputCount}/${courtCount} StreamRun workflows expose a separate preview outputstream; courts without one use the combined outputstream fallback.`,
      "Add separate preview output branches to the remaining StreamRun workflows if clean no-overlay MediaMTX preview is required on every court."
    );
  } else {
    notes.splice(1, 0, "All StreamRun workflows expose separate YouTube and preview outputstreams.");
  }

  return notes;
}

function normalizeElements(value: StreamRunConfiguration["elements"]): StreamRunElement[] {
  if (!value) return [];
  return Array.isArray(value) ? value : Object.values(value);
}

function findStreamConfiguration(configurations: StreamRunConfiguration[], court: number) {
  return configurations.find((configuration) => new RegExp(`^Stream\\s+${court}$`, "i").test(configuration.name));
}

function findYoutubeDestination(destinations: StreamRunDestination[], court: number) {
  return destinations.find((destination) => (
    destination.platform.toLowerCase() === "youtube" &&
    new RegExp(`stream\\s+key\\s+${court}$`, "i").test(destination.name)
  ));
}

function findPreviewDestination(destinations: StreamRunDestination[], court: number) {
  const courtLabel = String(court).padStart(2, "0");
  return destinations.find((destination) => (
    destination.name.toLowerCase().includes(`court-${courtLabel}`) &&
    destination.name.toLowerCase().includes("preview")
  ));
}

function pickDestination(destination: StreamRunDestination) {
  return {
    id: destination.id,
    name: destination.name,
    platform: destination.platform
  };
}

function stringArraySetting(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function gaps(input: {
  configuration?: StreamRunConfiguration;
  input: string | null;
  htmlOverlay: string | null;
  youtubeOutput: string | null;
  previewOutput: string | null;
  youtubeDestination?: StreamRunDestination;
  previewDestination?: StreamRunDestination;
  mediamtx: MediaMtxIngest | null;
  savedOverlayUrl: string | null;
  expectedOverlayUrl: string;
  savedYoutubeDestinations: string[];
  expectedYoutubeDestinations: string[];
  savedPreviewDestinations: string[];
  expectedPreviewDestinations: string[];
}) {
  const gaps: string[] = [];
  if (!input.configuration) gaps.push("Missing StreamRun configuration named Stream N");
  if (!input.input) gaps.push("Missing inputstream element");
  if (!input.htmlOverlay) gaps.push("Missing htmloverlay element");
  if (!input.youtubeOutput) gaps.push("Missing YouTube outputstream element");
  if (!input.previewOutput) gaps.push("Missing separate preview outputstream element");
  if (!input.youtubeDestination) gaps.push("Missing YouTube destination for stream key N");
  if (!input.previewDestination) gaps.push("Missing StreamRun MediaMTX preview destination");
  if (!input.mediamtx?.rtmpServerUrl || !input.mediamtx.streamKeyValue) gaps.push("Missing MEDIAMTX_RTMP_INGEST_BASE env for MediaMTX RTMP paste values");
  if (input.htmlOverlay && input.savedOverlayUrl !== input.expectedOverlayUrl) gaps.push("Saved HTML overlay URL does not match expected production overlay URL");
  if (input.youtubeOutput && input.expectedYoutubeDestinations.length && !sameStringArray(input.savedYoutubeDestinations, input.expectedYoutubeDestinations)) {
    gaps.push("Saved YouTube output destinations do not match expected YouTube-only output");
  }
  if (input.previewOutput && input.expectedPreviewDestinations.length && !sameStringArray(input.savedPreviewDestinations, input.expectedPreviewDestinations)) {
    gaps.push("Saved preview output destinations do not match expected MediaMTX-only output");
  }
  return gaps;
}

function pasteSheet(courts: Array<{
  court: number;
  configurationId: string | null;
  configurationName: string | null;
  elements: { htmlOverlay: string | null; youtubeOutput: string | null; previewOutput: string | null };
  savedSettings: { overlayUrl: string | null; youtubeDestinations: string[]; previewDestinations: string[] };
  expectedSettings: { overlayUrl: string; youtubeDestinations: string[]; previewDestinations: string[] };
  destinations: { youtube: ReturnType<typeof pickDestination> | null; mediaMtxPreview: ReturnType<typeof pickDestination> | null };
  overlayUrl: string;
  mediamtx: MediaMtxIngest | null;
  gaps: string[];
}>, redacted = false) {
  const lines = [
    "# StreamRun AVP Denver Setup",
    "",
    "Do not commit this file. It contains MediaMTX publish credentials when generated without redaction.",
    ""
  ];
  for (const court of courts) {
    lines.push(`## Court ${court.court}`);
    lines.push("");
    lines.push(`Configuration: ${court.configurationName ?? "missing"} (${court.configurationId ?? "missing"})`);
    lines.push(`HTML overlay element: ${court.elements.htmlOverlay ?? "missing"}`);
    lines.push(`YouTube output element: ${court.elements.youtubeOutput ?? "missing"}`);
    lines.push(`Preview output element: ${court.elements.previewOutput ?? "missing"}`);
    lines.push(`YouTube destination: ${court.destinations.youtube?.name ?? "missing"} (${court.destinations.youtube?.id ?? "missing"})`);
    lines.push(`MediaMTX preview destination: ${court.destinations.mediaMtxPreview?.name ?? "missing"} (${court.destinations.mediaMtxPreview?.id ?? "missing"})`);
    lines.push(`Overlay URL: ${court.overlayUrl}`);
    lines.push(`Saved overlay URL matches: ${court.savedSettings.overlayUrl === court.expectedSettings.overlayUrl ? "yes" : "no"}`);
    lines.push(`Saved YouTube output destinations match: ${sameStringArray(court.savedSettings.youtubeDestinations, court.expectedSettings.youtubeDestinations) ? "yes" : "no"}`);
    lines.push(`Saved preview output destinations match: ${sameStringArray(court.savedSettings.previewDestinations, court.expectedSettings.previewDestinations) ? "yes" : "no"}`);
    lines.push(`MediaMTX RTMP server: ${court.mediamtx?.rtmpServerUrl ?? "missing"}`);
    lines.push(`MediaMTX stream key: ${redacted ? redactSecret(court.mediamtx?.streamKeyValue) : court.mediamtx?.streamKeyValue ?? "missing"}`);
    if (court.gaps.length) {
      lines.push("");
      lines.push("Required manual/API follow-up:");
      for (const gap of court.gaps) lines.push(`- ${gap}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function redactSecret(value?: string) {
  if (!value) return "missing";
  if (!value.includes("?")) return value;
  return `${value.slice(0, value.indexOf("?"))}?[redacted]`;
}

function operationsReport(setup: {
  generatedAt: string;
  baseUrl: string;
  mode: string;
  mediaMtxRtmpIngestBase: string | null;
  summary: Record<string, number>;
  notes: string[];
  courts: Array<{
    court: number;
    configurationId: string | null;
    configurationName: string | null;
    elements: {
      input: string | null;
      htmlOverlay: string | null;
      youtubeOutput: string | null;
      previewOutput: string | null;
      outputCount: number;
    };
    destinations: {
      youtube: ReturnType<typeof pickDestination> | null;
      mediaMtxPreview: ReturnType<typeof pickDestination> | null;
    };
    overlayUrl: string;
    mediamtx: MediaMtxIngest | null;
    gaps: string[];
  }>;
}) {
  const lines = [
    "# ScoreCheck AVP Denver Operations Report",
    "",
    `Generated: ${setup.generatedAt}`,
    `StreamRun base URL: ${setup.baseUrl}`,
    `StreamRun mode: ${setup.mode}`,
    `MediaMTX RTMP ingest base: ${setup.mediaMtxRtmpIngestBase ?? "missing"}`,
    "",
    "## Summary",
    "",
    `- StreamRun configurations mapped: ${setup.summary.configurationsMapped}`,
    `- YouTube destinations mapped: ${setup.summary.youtubeDestinationsMapped}`,
    `- MediaMTX preview destinations mapped: ${setup.summary.previewDestinationsMapped}`,
    `- HTML overlays mapped: ${setup.summary.courtsWithHtmlOverlay}`,
    `- Separate preview output elements mapped: ${setup.summary.courtsWithSeparatePreviewOutput}`,
    `- MediaMTX paste values available locally: ${setup.summary.courtsWithMediaMtxPasteValues}`,
    `- Saved HTML overlay URLs matched: ${setup.summary.courtsWithSavedOverlayUrl}`,
    `- Saved YouTube output destinations matched: ${setup.summary.courtsWithSavedYoutubeOutput}`,
    `- Saved preview output destinations matched: ${setup.summary.courtsWithSavedPreviewOutput}`,
    "",
    "## Court Mapping",
    "",
    "| Court | StreamRun config | Overlay element | YouTube output | YouTube destination | Preview output | Preview destination | MediaMTX stream path | Overlay URL | Gaps |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];

  for (const court of setup.courts) {
    lines.push([
      court.court,
      `${court.configurationName ?? "missing"} (${court.configurationId ?? "missing"})`,
      court.elements.htmlOverlay ?? "missing",
      court.elements.youtubeOutput ?? "missing",
      court.destinations.youtube ? `${court.destinations.youtube.name} (${court.destinations.youtube.id})` : "missing",
      court.elements.previewOutput ?? "missing",
      court.destinations.mediaMtxPreview ? `${court.destinations.mediaMtxPreview.name} (${court.destinations.mediaMtxPreview.id})` : "missing",
      court.mediamtx?.streamPath ?? "missing",
      court.overlayUrl,
      court.gaps.length ? court.gaps.join("; ") : "none"
    ].map(tableCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  lines.push("");
  lines.push("## Manual StreamRun Follow-Up");
  lines.push("");
  lines.push("- Combined-output launch overrides are available now: the existing outputstream can target both YouTube and the MediaMTX preview.");
  lines.push("- Add a separate preview outputstream element to each StreamRun workflow if clean preview output without the YouTube overlay is required.");
  lines.push("- If separate preview outputstreams are added, attach each MediaMTX preview destination to the new preview branch in the StreamRun Editor.");
  lines.push("- Re-run `npm run setup:streamrun:discover` and `npm run setup:streamrun` after editor changes.");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  for (const note of setup.notes) lines.push(`- ${note}`);
  lines.push("");
  lines.push("This report intentionally excludes MediaMTX publish credentials, Supabase service role keys, StreamRun API keys, Vercel tokens, and YouTube refresh tokens.");
  return `${lines.join("\n")}\n`;
}

function tableCell(value: unknown) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
