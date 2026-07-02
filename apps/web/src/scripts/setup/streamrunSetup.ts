import fs from "node:fs";
import path from "node:path";
import { getEnv } from "../../lib/env";
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

type AwsIvsChannel = {
  court: number;
  channelArn: string;
  ingestEndpoint: string;
  playbackUrl: string;
  streamKeyArn: string;
  streamKeyValue: string;
  rtmpsServerUrl: string;
};

loadLocalEnv();

const outputDir = path.join(process.cwd(), ".local");
const discoveryPath = path.join(outputDir, "streamrun-discovery.generated.json");
const awsIvsPath = path.join(outputDir, "aws-ivs.generated.json");
const env = getEnv();
const publicSiteUrl = env.publicSiteUrl.replace(/\/$/, "");

main();

function main() {
  if (!fs.existsSync(discoveryPath)) {
    throw new Error("Run npm run setup:streamrun:discover before setup:streamrun");
  }
  if (!fs.existsSync(awsIvsPath)) {
    throw new Error("Run npm run setup:aws-ivs before setup:streamrun");
  }

  const discovery = JSON.parse(fs.readFileSync(discoveryPath, "utf8")) as {
    configurations?: { configurations?: StreamRunConfiguration[] };
    destinations?: { destinations?: StreamRunDestination[] };
  };
  const awsIvs = JSON.parse(fs.readFileSync(awsIvsPath, "utf8")) as { channels?: AwsIvsChannel[] };
  const configurations = discovery.configurations?.configurations ?? [];
  const destinations = discovery.destinations?.destinations ?? [];
  const channels = awsIvs.channels ?? [];

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
    const ivsOutputElement = outputElements[1] ?? null;
    const youtubeOutput = youtubeOutputElement?.id ?? null;
    const ivsOutput = ivsOutputElement?.id ?? null;
    const youtubeDestination = findYoutubeDestination(destinations, court);
    const ivsDestination = findIvsDestination(destinations, court);
    const ivsChannel = channels.find((channel) => channel.court === court) ?? null;
    const overlayUrl = `${publicSiteUrl}/overlay/stream/${court}`;
    const expectedYoutubeDestinations = youtubeOutput && youtubeDestination
      ? [
        youtubeDestination.id,
        ...(!ivsOutput && ivsDestination ? [ivsDestination.id] : [])
      ]
      : [];
    const expectedIvsDestinations = ivsOutput && ivsDestination ? [ivsDestination.id] : [];
    const launchOverrides: Record<string, unknown> = {};
    if (htmlOverlay) launchOverrides[htmlOverlay] = { url: overlayUrl, visible: true };
    if (youtubeOutput && youtubeDestination) {
      launchOverrides[youtubeOutput] = {
        destinations: expectedYoutubeDestinations
      };
    }
    if (ivsOutput && ivsDestination) launchOverrides[ivsOutput] = { destinations: expectedIvsDestinations };
    return {
      court,
      configurationId: configuration?.id ?? null,
      configurationName: configuration?.name ?? null,
      elements: {
        input,
        htmlOverlay,
        youtubeOutput,
        ivsOutput,
        outputCount: outputs.length
      },
      savedSettings: {
        overlayUrl: typeof htmlOverlayElement?.settings?.url === "string" ? htmlOverlayElement.settings.url : null,
        youtubeDestinations: stringArraySetting(youtubeOutputElement?.settings?.destinations),
        ivsDestinations: stringArraySetting(ivsOutputElement?.settings?.destinations)
      },
      expectedSettings: {
        overlayUrl,
        youtubeDestinations: expectedYoutubeDestinations,
        ivsDestinations: expectedIvsDestinations
      },
      destinations: {
        youtube: youtubeDestination ? pickDestination(youtubeDestination) : null,
        ivsPreview: ivsDestination ? pickDestination(ivsDestination) : null
      },
      overlayUrl,
      ivs: ivsChannel ? {
        channelArn: ivsChannel.channelArn,
        playbackUrl: ivsChannel.playbackUrl,
        rtmpsServerUrl: ivsChannel.rtmpsServerUrl,
        streamKeyArn: ivsChannel.streamKeyArn,
        streamKeyValue: ivsChannel.streamKeyValue
      } : null,
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
      fallbackMode: !ivsOutput && youtubeOutput && ivsDestination ? "combined-youtube-and-ivs-output" : null,
      gaps: gaps({
        configuration,
        input,
        htmlOverlay,
        youtubeOutput,
        ivsOutput,
        youtubeDestination,
        ivsDestination,
        ivsChannel,
        savedOverlayUrl: typeof htmlOverlayElement?.settings?.url === "string" ? htmlOverlayElement.settings.url : null,
        expectedOverlayUrl: overlayUrl,
        savedYoutubeDestinations: stringArraySetting(youtubeOutputElement?.settings?.destinations),
        expectedYoutubeDestinations,
        savedIvsDestinations: stringArraySetting(ivsOutputElement?.settings?.destinations),
        expectedIvsDestinations
      })
    };
  });

  const separateIvsOutputCount = courts.filter((court) => court.elements.ivsOutput).length;
  const setup = {
    generatedAt: new Date().toISOString(),
    baseUrl: process.env.STREAMRUN_BASE_URL || "https://streamrun.com",
    mode: "one-configuration-per-court",
    courts,
    summary: {
      configurationsMapped: courts.filter((court) => court.configurationId).length,
      youtubeDestinationsMapped: courts.filter((court) => court.destinations.youtube).length,
      ivsDestinationsMapped: courts.filter((court) => court.destinations.ivsPreview).length,
      courtsWithHtmlOverlay: courts.filter((court) => court.elements.htmlOverlay).length,
      courtsWithSeparateIvsOutput: separateIvsOutputCount,
      courtsWithIvsPasteValues: courts.filter((court) => court.ivs?.rtmpsServerUrl && court.ivs?.streamKeyValue).length,
      courtsWithSavedOverlayUrl: courts.filter((court) => court.savedSettings.overlayUrl === court.expectedSettings.overlayUrl).length,
      courtsWithSavedYoutubeOutput: courts.filter((court) => sameStringArray(court.savedSettings.youtubeDestinations, court.expectedSettings.youtubeDestinations)).length,
      courtsWithSavedIvsOutput: courts.filter((court) => sameStringArray(court.savedSettings.ivsDestinations, court.expectedSettings.ivsDestinations)).length
    },
    notes: streamRunNotes(separateIvsOutputCount, env.courtCount)
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

function streamRunNotes(separateIvsOutputCount: number, courtCount: number) {
  const notes = [
    "Existing StreamRun destination API responses do not expose RTMP server URL fields, so custom IVS destinations are generated as a manual paste sheet.",
    "Launch requests include YouTube destination, IVS destination, and HTML overlay overrides only when those IDs are mapped.",
    "Before changing IVS destinations or sending local test video, read docs/STREAMRUN_IVS_PREVIEW_RUNBOOK.md for the RTMPS destination and UDP-to-SRT sender requirements."
  ];

  if (separateIvsOutputCount === 0) {
    notes.splice(1, 0,
      "No StreamRun workflows expose a separate IVS outputstream; launch requests attach IVS preview destinations to the same outputstream as a fallback.",
      "Add a separate IVS output branch in the editor later if a clean no-overlay IVS preview path is required."
    );
  } else if (separateIvsOutputCount < courtCount) {
    notes.splice(1, 0,
      `${separateIvsOutputCount}/${courtCount} StreamRun workflows expose a separate IVS outputstream; courts without one use the combined outputstream fallback.`,
      "Add separate IVS output branches to the remaining StreamRun workflows if clean no-overlay IVS preview is required on every court."
    );
  } else {
    notes.splice(1, 0, "All StreamRun workflows expose separate YouTube and IVS outputstreams.");
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

function findIvsDestination(destinations: StreamRunDestination[], court: number) {
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
  ivsOutput: string | null;
  youtubeDestination?: StreamRunDestination;
  ivsDestination?: StreamRunDestination;
  ivsChannel: AwsIvsChannel | null;
  savedOverlayUrl: string | null;
  expectedOverlayUrl: string;
  savedYoutubeDestinations: string[];
  expectedYoutubeDestinations: string[];
  savedIvsDestinations: string[];
  expectedIvsDestinations: string[];
}) {
  const gaps: string[] = [];
  if (!input.configuration) gaps.push("Missing StreamRun configuration named Stream N");
  if (!input.input) gaps.push("Missing inputstream element");
  if (!input.htmlOverlay) gaps.push("Missing htmloverlay element");
  if (!input.youtubeOutput) gaps.push("Missing YouTube outputstream element");
  if (!input.ivsOutput) gaps.push("Missing separate IVS outputstream element");
  if (!input.youtubeDestination) gaps.push("Missing YouTube destination for stream key N");
  if (!input.ivsDestination) gaps.push("Missing StreamRun IVS preview destination");
  if (!input.ivsChannel?.rtmpsServerUrl || !input.ivsChannel.streamKeyValue) gaps.push("Missing local AWS IVS RTMPS URL or stream key value");
  if (input.htmlOverlay && input.savedOverlayUrl !== input.expectedOverlayUrl) gaps.push("Saved HTML overlay URL does not match expected production overlay URL");
  if (input.youtubeOutput && input.expectedYoutubeDestinations.length && !sameStringArray(input.savedYoutubeDestinations, input.expectedYoutubeDestinations)) {
    gaps.push("Saved YouTube output destinations do not match expected YouTube-only output");
  }
  if (input.ivsOutput && input.expectedIvsDestinations.length && !sameStringArray(input.savedIvsDestinations, input.expectedIvsDestinations)) {
    gaps.push("Saved IVS output destinations do not match expected IVS-only output");
  }
  return gaps;
}

function pasteSheet(courts: Array<{
  court: number;
  configurationId: string | null;
  configurationName: string | null;
  elements: { htmlOverlay: string | null; youtubeOutput: string | null; ivsOutput: string | null };
  savedSettings: { overlayUrl: string | null; youtubeDestinations: string[]; ivsDestinations: string[] };
  expectedSettings: { overlayUrl: string; youtubeDestinations: string[]; ivsDestinations: string[] };
  destinations: { youtube: ReturnType<typeof pickDestination> | null; ivsPreview: ReturnType<typeof pickDestination> | null };
  overlayUrl: string;
  ivs: { rtmpsServerUrl: string; streamKeyValue: string } | null;
  gaps: string[];
}>, redacted = false) {
  const lines = [
    "# StreamRun AVP Denver Setup",
    "",
    "Do not commit this file. It contains IVS stream keys when generated without redaction.",
    ""
  ];
  for (const court of courts) {
    lines.push(`## Court ${court.court}`);
    lines.push("");
    lines.push(`Configuration: ${court.configurationName ?? "missing"} (${court.configurationId ?? "missing"})`);
    lines.push(`HTML overlay element: ${court.elements.htmlOverlay ?? "missing"}`);
    lines.push(`YouTube output element: ${court.elements.youtubeOutput ?? "missing"}`);
    lines.push(`IVS output element: ${court.elements.ivsOutput ?? "missing"}`);
    lines.push(`YouTube destination: ${court.destinations.youtube?.name ?? "missing"} (${court.destinations.youtube?.id ?? "missing"})`);
    lines.push(`IVS destination: ${court.destinations.ivsPreview?.name ?? "missing"} (${court.destinations.ivsPreview?.id ?? "missing"})`);
    lines.push(`Overlay URL: ${court.overlayUrl}`);
    lines.push(`Saved overlay URL matches: ${court.savedSettings.overlayUrl === court.expectedSettings.overlayUrl ? "yes" : "no"}`);
    lines.push(`Saved YouTube output destinations match: ${sameStringArray(court.savedSettings.youtubeDestinations, court.expectedSettings.youtubeDestinations) ? "yes" : "no"}`);
    lines.push(`Saved IVS output destinations match: ${sameStringArray(court.savedSettings.ivsDestinations, court.expectedSettings.ivsDestinations) ? "yes" : "no"}`);
    lines.push(`IVS RTMPS server: ${court.ivs?.rtmpsServerUrl ?? "missing"}`);
    lines.push(`IVS stream key: ${redacted ? redactSecret(court.ivs?.streamKeyValue) : court.ivs?.streamKeyValue ?? "missing"}`);
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
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function operationsReport(setup: {
  generatedAt: string;
  baseUrl: string;
  mode: string;
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
      ivsOutput: string | null;
      outputCount: number;
    };
    destinations: {
      youtube: ReturnType<typeof pickDestination> | null;
      ivsPreview: ReturnType<typeof pickDestination> | null;
    };
    overlayUrl: string;
    ivs: {
      channelArn: string;
      playbackUrl: string;
      rtmpsServerUrl: string;
      streamKeyArn: string;
      streamKeyValue: string;
    } | null;
    gaps: string[];
  }>;
}) {
  const lines = [
    "# ScoreCheck AVP Denver Operations Report",
    "",
    `Generated: ${setup.generatedAt}`,
    `StreamRun base URL: ${setup.baseUrl}`,
    `StreamRun mode: ${setup.mode}`,
    "",
    "## Summary",
    "",
    `- StreamRun configurations mapped: ${setup.summary.configurationsMapped}`,
    `- YouTube destinations mapped: ${setup.summary.youtubeDestinationsMapped}`,
    `- IVS destinations mapped: ${setup.summary.ivsDestinationsMapped}`,
    `- HTML overlays mapped: ${setup.summary.courtsWithHtmlOverlay}`,
    `- Separate IVS output elements mapped: ${setup.summary.courtsWithSeparateIvsOutput}`,
    `- IVS paste values available locally: ${setup.summary.courtsWithIvsPasteValues}`,
    `- Saved HTML overlay URLs matched: ${setup.summary.courtsWithSavedOverlayUrl}`,
    `- Saved YouTube output destinations matched: ${setup.summary.courtsWithSavedYoutubeOutput}`,
    `- Saved IVS output destinations matched: ${setup.summary.courtsWithSavedIvsOutput}`,
    "",
    "## Court Mapping",
    "",
    "| Court | StreamRun config | Overlay element | YouTube output | YouTube destination | IVS output | IVS destination | IVS channel ARN | IVS playback URL | Overlay URL | Gaps |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  ];

  for (const court of setup.courts) {
    lines.push([
      court.court,
      `${court.configurationName ?? "missing"} (${court.configurationId ?? "missing"})`,
      court.elements.htmlOverlay ?? "missing",
      court.elements.youtubeOutput ?? "missing",
      court.destinations.youtube ? `${court.destinations.youtube.name} (${court.destinations.youtube.id})` : "missing",
      court.elements.ivsOutput ?? "missing",
      court.destinations.ivsPreview ? `${court.destinations.ivsPreview.name} (${court.destinations.ivsPreview.id})` : "missing",
      court.ivs?.channelArn ?? "missing",
      court.ivs?.playbackUrl ?? "missing",
      court.overlayUrl,
      court.gaps.length ? court.gaps.join("; ") : "none"
    ].map(tableCell).join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }

  lines.push("");
  lines.push("## Manual StreamRun Follow-Up");
  lines.push("");
  lines.push("- Combined-output launch overrides are available now: the existing outputstream can target both YouTube and IVS.");
  lines.push("- Add a separate IVS outputstream element to each StreamRun workflow if clean preview output without the YouTube overlay is required.");
  lines.push("- If separate IVS outputstreams are added, attach each IVS destination to the new IVS branch in the StreamRun Editor.");
  lines.push("- Re-run `npm run setup:streamrun:discover` and `npm run setup:streamrun` after editor changes.");
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  for (const note of setup.notes) lines.push(`- ${note}`);
  lines.push("");
  lines.push("This report intentionally excludes IVS stream keys, private keys, Supabase service role keys, StreamRun API keys, Vercel tokens, and YouTube refresh tokens.");
  return `${lines.join("\n")}\n`;
}

function tableCell(value: unknown) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}
