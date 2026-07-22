#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadProtectedEnv } from "./stack-deployer.mjs";
import { readProductionDestinations } from "./production-youtube.mjs";
import { validateRendererBinding } from "./renderer-binding.mjs";
import { evaluateVenueAdmission, validateVenueProfile } from "./venue-admission.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const SOURCE_SCHEMA_VERSION = 2;
const MATERIAL_SCHEMA_VERSION = 2;
const LEGACY_SOURCE_SCHEMA_VERSION = 1;
const LEGACY_MATERIAL_SCHEMA_VERSION = 1;
const PRODUCTION_OUTPUT_PROFILES = Object.freeze(["1080p30", "1080p60"]);
const SOURCE_FILES = Object.freeze([
  "material.json",
  "monitoring.env",
  "web-runtime.env",
  "wireguard/camera-lan.conf",
  "wireguard/camera-lan.key",
  "wireguard/camera-lan.pub"
]);
const OMITTED_MONITORING_KEYS = new Set([
  "COMMENTARY_MONITOR_AGENT_TOKEN",
  "MONITOR_AGENT_TARGETS",
  "PREVIEW_MONITOR_AGENT_TOKEN"
]);
const REQUIRED_MONITORING_KEYS = Object.freeze([
  "ALERTMANAGER_WEBHOOK_TOKEN",
  "HEALTHCHECKS_ACTIVE_CHECK_ID",
  "HEALTHCHECKS_ACTIVE_PING_URL",
  "HEALTHCHECKS_API_KEY",
  "HEALTHCHECKS_BASELINE_CHECK_ID",
  "HEALTHCHECKS_BASELINE_PING_URL",
  "HEALTHCHECKS_SENTINEL_PING_URL",
  "MONITOR_API_TOKEN",
  "MONITOR_BROWSER_ALLOWED_ORIGINS",
  "MONITOR_BROWSER_HEARTBEAT_SECRET",
  "MONITOR_DASHBOARD_URL",
  "MONITOR_PUBLIC_HOST",
  "PUSHOVER_APP_TOKEN",
  "PUSHOVER_USER_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_URL",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN"
]);

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return usage();
  if (options.command === "capture") {
    const result = await createProductionRecoverySource(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.command === "migrate-youtube") {
    const result = await migrateProductionRecoverySource(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const source = await loadProductionRecoverySource(options.source);
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    source: options.source,
    schemaVersion: source.marker.schemaVersion,
    fileCount: Object.keys(source.marker.files).length,
    sourceSha256: source.sourceSha256
  }, null, 2)}\n`);
}

export async function createProductionRecoverySource({ captureRoot, output }) {
  await verifyProtectedCapture(captureRoot);
  const paths = capturePaths(captureRoot);
  const [globalConfig, pathConfig, webEnvironment, monitoringEnvironment, ...compositorEnvironments] = await Promise.all([
    readProtectedJson(paths.ingestConfig, "ingest global configuration"),
    readProtectedJson(paths.ingestPathConfig, "ingest path configuration"),
    loadProtectedEnv(paths.webEnvironment),
    loadProtectedEnv(paths.monitoringEnvironment),
    ...paths.compositorEnvironments.map((path) => loadProtectedEnv(path))
  ]);
  const material = buildProductionMaterial({
    globalConfig,
    pathConfig,
    webEnvironment,
    monitoringEnvironment,
    compositorEnvironments
  });
  const filteredMonitoring = filterMonitoringEnvironment(monitoringEnvironment);
  const webRuntime = buildRecoveryWebEnvironment({ webEnvironment, monitoringEnvironment, material });
  const captureSha256 = sha256(await readFile(join(captureRoot, "SHA256SUMS")));
  const target = normalizedAbsolute(output, "production recovery source");
  await assertProtectedParent(target);
  await assertAbsent(target, "production recovery source");
  const temporary = `${target}.rendering-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(temporary, "wireguard"), { recursive: true, mode: 0o700 });
  await chmod(temporary, 0o700);
  await chmod(join(temporary, "wireguard"), 0o700);
  try {
    await writeProtected(join(temporary, "material.json"), `${JSON.stringify(material, null, 2)}\n`);
    await writeProtected(join(temporary, "monitoring.env"), envFile(filteredMonitoring));
    await writeProtected(join(temporary, "web-runtime.env"), envFile(webRuntime));
    for (const name of ["camera-lan.conf", "camera-lan.key", "camera-lan.pub"]) {
      await assertProtectedFile(join(paths.wireguard, name), `WireGuard ${name}`);
      await copyFile(join(paths.wireguard, name), join(temporary, "wireguard", name));
      await chmod(join(temporary, "wireguard", name), 0o600);
    }
    const marker = {
      schemaVersion: SOURCE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      captureSha256,
      files: await hashesForFiles(temporary, SOURCE_FILES)
    };
    await writeProtected(join(temporary, "SOURCE_COMPLETE.json"), `${JSON.stringify(marker, null, 2)}\n`);
    await rename(temporary, target);
    await chmod(target, 0o700);
    const loaded = await loadProductionRecoverySource(target);
    return {
      status: "PASS",
      source: target,
      fileCount: Object.keys(loaded.marker.files).length,
      sourceSha256: loaded.sourceSha256
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function migrateProductionRecoverySource({ source, destinations, output }) {
  const legacy = await loadLegacyProductionRecoverySource(source);
  const youtube = await readProductionDestinations(destinations);
  const material = migrateProductionMaterial({ legacyMaterial: legacy.material, destinations: youtube });
  const target = normalizedAbsolute(output, "production recovery source");
  await assertProtectedParent(target);
  await assertAbsent(target, "production recovery source");
  const temporary = `${target}.rendering-${process.pid}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(join(temporary, "wireguard"), { recursive: true, mode: 0o700 });
  await chmod(temporary, 0o700);
  await chmod(join(temporary, "wireguard"), 0o700);
  try {
    await writeProtected(join(temporary, "material.json"), `${JSON.stringify(material, null, 2)}\n`);
    for (const name of SOURCE_FILES.filter((entry) => entry !== "material.json")) {
      const sourcePath = join(legacy.root, name);
      const targetPath = join(temporary, name);
      await copyFile(sourcePath, targetPath);
      await chmod(targetPath, 0o600);
    }
    const marker = {
      schemaVersion: SOURCE_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      captureSha256: legacy.marker.captureSha256,
      migratedFromSourceSha256: legacy.sourceSha256,
      youtubeDestinationsSha256: sha256(await readFile(destinations)),
      files: await hashesForFiles(temporary, SOURCE_FILES)
    };
    await writeProtected(join(temporary, "SOURCE_COMPLETE.json"), `${JSON.stringify(marker, null, 2)}\n`);
    await rename(temporary, target);
    await chmod(target, 0o700);
    const loaded = await loadProductionRecoverySource(target);
    return {
      status: "PASS",
      source: target,
      schemaVersion: loaded.marker.schemaVersion,
      fileCount: Object.keys(loaded.marker.files).length,
      sourceSha256: loaded.sourceSha256
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export function migrateProductionMaterial({ legacyMaterial, destinations }) {
  validateLegacyProductionMaterial(legacyMaterial);
  if (!destinations || destinations.schemaVersion !== 1 || !destinations.streams) throw new Error("production YouTube destinations are invalid");
  const compositors = {};
  for (const court of COURTS) {
    const legacy = legacyMaterial.compositors[court];
    const stream = destinations.streams[court];
    if (!stream || stream.court !== court || stream.resolution !== "variable" || stream.frameRate !== "variable") {
      throw new Error(`Camera ${court} production YouTube destination is invalid`);
    }
    compositors[court] = {
      apiKey: legacy.apiKey,
      apiSecret: legacy.apiSecret,
      rtmpsBase: requireRtmps(stream.rtmpsIngestionAddress, `Camera ${court} YouTube RTMPS base`),
      streamKey: requireSecret(stream.streamName, `Camera ${court} YouTube stream key`, 8),
      streamId: requireProviderId(stream.id, `Camera ${court} YouTube stream id`),
      youtubeResolution: "variable",
      youtubeFrameRate: "variable",
      outputProfiles: [...PRODUCTION_OUTPUT_PROFILES]
    };
  }
  const material = {
    schemaVersion: MATERIAL_SCHEMA_VERSION,
    programPageToken: legacyMaterial.programPageToken,
    commentary: { ...legacyMaterial.commentary },
    publishers: structuredClone(legacyMaterial.publishers),
    compositors
  };
  return validateProductionMaterial(material);
}

export function buildProductionMaterial({ globalConfig, pathConfig, webEnvironment, monitoringEnvironment, compositorEnvironments }) {
  if (!globalConfig || !Array.isArray(globalConfig.authInternalUsers)) throw new Error("ingest global configuration has no internal users");
  if (!pathConfig || !Array.isArray(pathConfig.items)) throw new Error("ingest path configuration has no items");
  if (!Array.isArray(compositorEnvironments) || compositorEnvironments.length === 0) throw new Error("at least one compositor environment is required");
  requireEnvironment(webEnvironment, ["LIVEKIT_COMMENTARY_API_KEY", "LIVEKIT_COMMENTARY_API_SECRET"]);
  requireEnvironment(monitoringEnvironment, REQUIRED_MONITORING_KEYS);
  rejectTwilio(monitoringEnvironment);

  const programTokens = unique(compositorEnvironments.map((environment) => required(environment, "PROGRAM_PAGE_TOKEN")));
  if (programTokens.length !== 1) throw new Error("compositor program-page tokens are inconsistent");
  const publishers = {};
  const compositors = {};
  for (const court of COURTS) {
    const pathName = `court${court}_raw`;
    const users = globalConfig.authInternalUsers.filter((entry) => Array.isArray(entry.permissions)
      && entry.permissions.some((permission) => permission?.action === "publish" && permission?.path === pathName));
    if (users.length !== 1) throw new Error(`Camera ${court} must have exactly one publisher credential`);
    const pathEntries = pathConfig.items.filter((entry) => entry?.name === pathName);
    if (pathEntries.length !== 1) throw new Error(`Camera ${court} must have exactly one raw-path configuration`);
    const source = pathEntries[0].source;
    if (source !== "publisher" && !(typeof source === "string" && source.startsWith("srt://"))) {
      throw new Error(`Camera ${court} raw source is invalid`);
    }
    publishers[court] = {
      user: requireSecret(users[0].user, `Camera ${court} publisher user`, 4),
      password: requireSecret(users[0].pass, `Camera ${court} publisher password`, 16),
      source
    };

    const keyName = `COURT_${court}_YOUTUBE_KEY`;
    const owners = compositorEnvironments.filter((environment) => typeof environment[keyName] === "string" && environment[keyName].trim());
    if (owners.length !== 1) throw new Error(`Camera ${court} must have exactly one protected YouTube stream key owner`);
    const owner = owners[0];
    const streamIdName = `COURT_${court}_YOUTUBE_STREAM_ID`;
    compositors[court] = {
      apiKey: requireSecret(owner.LIVEKIT_API_KEY, `Camera ${court} compositor API key`, 8),
      apiSecret: requireSecret(owner.LIVEKIT_API_SECRET, `Camera ${court} compositor API secret`, 24),
      rtmpsBase: requireRtmps(owner.YOUTUBE_RTMPS_BASE, `Camera ${court} YouTube RTMPS base`),
      streamKey: requireSecret(owner[keyName], `Camera ${court} YouTube stream key`, 8),
      streamId: requireProviderId(owner[streamIdName], `Camera ${court} YouTube stream id`),
      ...variableYouTubeProfile(owner)
    };
  }
  const material = {
    schemaVersion: MATERIAL_SCHEMA_VERSION,
    programPageToken: requireSecret(programTokens[0], "program-page token", 24),
    commentary: {
      apiKey: requireSecret(webEnvironment.LIVEKIT_COMMENTARY_API_KEY, "commentary API key", 8),
      apiSecret: requireSecret(webEnvironment.LIVEKIT_COMMENTARY_API_SECRET, "commentary API secret", 24)
    },
    publishers,
    compositors
  };
  validateProductionMaterial(material);
  return material;
}

export async function loadProductionRecoverySource(sourceDirectory) {
  const root = normalizedAbsolute(sourceDirectory, "production recovery source");
  await assertProtectedDirectory(root, "production recovery source");
  const marker = await readProtectedJson(join(root, "SOURCE_COMPLETE.json"), "production recovery marker");
  if (marker.schemaVersion !== SOURCE_SCHEMA_VERSION || !marker.files || typeof marker.files !== "object" || Array.isArray(marker.files)) {
    throw new Error("production recovery marker is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(marker.captureSha256 ?? "")) throw new Error("production recovery capture binding is invalid");
  if (JSON.stringify(Object.keys(marker.files).sort()) !== JSON.stringify([...SOURCE_FILES].sort())) {
    throw new Error("production recovery source file set is incomplete");
  }
  for (const [name, expected] of Object.entries(marker.files)) {
    validateRelativeFile(name);
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("production recovery source digest is invalid");
    const path = join(root, name);
    await assertProtectedFile(path, `production recovery ${name}`);
    if (sha256(await readFile(path)) !== expected) throw new Error(`production recovery ${name} failed integrity verification`);
  }
  const material = JSON.parse(await readFile(join(root, "material.json"), "utf8"));
  validateProductionMaterial(material);
  const monitoringEnvironment = await loadProtectedEnv(join(root, "monitoring.env"));
  requireEnvironment(monitoringEnvironment, REQUIRED_MONITORING_KEYS);
  rejectTwilio(monitoringEnvironment);
  const sourceSha256 = sha256(Buffer.from(stableJson({ captureSha256: marker.captureSha256, files: marker.files }), "utf8"));
  return { root, marker, material, monitoringEnvironment, sourceSha256 };
}

async function loadLegacyProductionRecoverySource(sourceDirectory) {
  const root = normalizedAbsolute(sourceDirectory, "legacy production recovery source");
  await assertProtectedDirectory(root, "legacy production recovery source");
  const marker = await readProtectedJson(join(root, "SOURCE_COMPLETE.json"), "legacy production recovery marker");
  if (marker.schemaVersion !== LEGACY_SOURCE_SCHEMA_VERSION || !marker.files || typeof marker.files !== "object" || Array.isArray(marker.files)) {
    throw new Error("legacy production recovery marker is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(marker.captureSha256 ?? "")) throw new Error("legacy production recovery capture binding is invalid");
  if (JSON.stringify(Object.keys(marker.files).sort()) !== JSON.stringify([...SOURCE_FILES].sort())) throw new Error("legacy production recovery source file set is incomplete");
  for (const [name, expected] of Object.entries(marker.files)) {
    validateRelativeFile(name);
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error("legacy production recovery source digest is invalid");
    const path = join(root, name);
    await assertProtectedFile(path, `legacy production recovery ${name}`);
    if (sha256(await readFile(path)) !== expected) throw new Error(`legacy production recovery ${name} failed integrity verification`);
  }
  const material = JSON.parse(await readFile(join(root, "material.json"), "utf8"));
  validateLegacyProductionMaterial(material);
  const monitoringEnvironment = await loadProtectedEnv(join(root, "monitoring.env"));
  requireEnvironment(monitoringEnvironment, REQUIRED_MONITORING_KEYS);
  rejectTwilio(monitoringEnvironment);
  const sourceSha256 = sha256(Buffer.from(stableJson({ captureSha256: marker.captureSha256, files: marker.files }), "utf8"));
  return { root, marker, material, monitoringEnvironment, sourceSha256 };
}

export async function renderProductionSecretDirectory({ manifest, sourceDirectory, directory, renderer, venueProfile, random = randomBytes }) {
  if (manifest?.kind !== "production" || !Array.isArray(manifest.droplets) || manifest.droplets.length !== 12) {
    throw new Error("production secrets require the exact 12-Droplet production manifest");
  }
  const rendererBinding = validateRendererBinding(renderer);
  validateVenueProfile(venueProfile, manifest.event);
  const source = await loadProductionRecoverySource(sourceDirectory);
  const target = normalizedAbsolute(directory, "production secret directory");
  const inputSha256 = sha256(Buffer.from(stableJson({ manifest, renderer: rendererBinding, venueProfile, sourceSha256: source.sourceSha256 }), "utf8"));
  if (await exists(target)) {
    await verifyRenderedDirectory(target, inputSha256);
    return target;
  }
  const root = `${target}.rendering`;
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "compositors"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "wireguard"), { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const agentTokens = Object.fromEntries(manifest.droplets.map((spec) => [spec.name, random(32).toString("base64url")]));
  const files = buildProductionSecretFiles({ manifest, material: source.material, monitoringEnvironment: source.monitoringEnvironment, renderer: rendererBinding, venueProfile, agentTokens });
  try {
    for (const [name, body] of Object.entries(files)) await writeProtected(join(root, name), body);
    for (const name of ["camera-lan.conf", "camera-lan.key", "camera-lan.pub"]) {
      await copyFile(join(source.root, "wireguard", name), join(root, "wireguard", name));
      await chmod(join(root, "wireguard", name), 0o600);
    }
    const names = [...Object.keys(files), "wireguard/camera-lan.conf", "wireguard/camera-lan.key", "wireguard/camera-lan.pub"].sort();
    const marker = { schemaVersion: 1, inputSha256, sourceSha256: source.sourceSha256, files: await hashesForFiles(root, names) };
    await writeProtected(join(root, "RENDER_COMPLETE.json"), `${JSON.stringify(marker, null, 2)}\n`);
    await rename(root, target);
    await chmod(target, 0o700);
    await verifyRenderedDirectory(target, inputSha256);
    return target;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function buildProductionSecretFiles({ manifest, material, monitoringEnvironment, renderer, venueProfile, agentTokens }) {
  validateProductionMaterial(material);
  const rendererBinding = validateRendererBinding(renderer);
  const validatedVenueProfile = validateVenueProfile(venueProfile, manifest.event);
  const venueAdmission = evaluateVenueAdmission(validatedVenueProfile);
  if (!venueAdmission.passed) throw new Error(`production venue profile is not admitted: ${venueAdmission.problems.join("; ")}`);
  requireEnvironment(monitoringEnvironment, REQUIRED_MONITORING_KEYS);
  rejectTwilio(monitoringEnvironment);
  const expectedNames = manifest.droplets.map((entry) => entry.name).sort();
  if (JSON.stringify(Object.keys(agentTokens ?? {}).sort()) !== JSON.stringify(expectedNames)) throw new Error("production agent tokens must exactly match the manifest");
  for (const [name, token] of Object.entries(agentTokens)) requireSecret(token, `${name} agent token`, 24);
  const observer = filterMonitoringEnvironment(monitoringEnvironment);
  observer.MONITOR_BROWSER_ALLOWED_ORIGINS = rendererBinding.origin;
  const output = {
    "agent-tokens.json": `${JSON.stringify({ schemaVersion: 1, tokens: agentTokens }, null, 2)}\n`,
    "commentary.env": envFile({
      LIVEKIT_COMMENTARY_API_KEY: material.commentary.apiKey,
      LIVEKIT_COMMENTARY_API_SECRET: material.commentary.apiSecret
    }),
    "ingest.env": envFile(Object.fromEntries([
      ["MEDIAMTX_PROGRAM_DELAY_MS", "3500"],
      ...COURTS.flatMap((court) => [
        [`MEDIAMTX_COURT_${court}_RAW_SOURCE`, material.publishers[court].source],
        [`MEDIAMTX_COURT_${court}_BROWSER_SOURCE`, venueAdmission.assignments[court]?.sourcePathMode === "isolated-hevc-normalizer" ? "normalized" : "raw"],
        [`MEDIAMTX_COURT_${court}_PUBLISH_USER`, material.publishers[court].user],
        [`MEDIAMTX_COURT_${court}_PUBLISH_PASS`, material.publishers[court].password]
      ])
    ])),
    "observability.env": envFile(observer),
    "source-binding.json": `${JSON.stringify({
      schemaVersion: 3,
      materialSha256: sha256(Buffer.from(stableJson(material), "utf8")),
      rendererSha256: sha256(Buffer.from(stableJson(rendererBinding), "utf8")),
      venueProfileSha256: sha256(Buffer.from(stableJson(validatedVenueProfile), "utf8")),
      renderer: rendererBinding
    }, null, 2)}\n`
  };
  for (const court of COURTS) {
    const spec = manifest.droplets.find((entry) => entry.role === "compositor" && entry.court === court);
    if (!spec) throw new Error(`production manifest has no compositor for Camera ${court}`);
    const compositor = material.compositors[court];
    output[`compositors/${spec.name}.env`] = compositorEnvironment({
      court,
      compositor,
      programPageToken: material.programPageToken,
      renderer: rendererBinding,
      assignment: venueAdmission.assignments[court] ?? null
    });
  }
  const spare = manifest.droplets.find((entry) => entry.role === "compositor-spare");
  if (!spare) throw new Error("production manifest has no warm spare");
  output[`compositors/${spare.name}.env`] = compositorEnvironment({ court: null, compositor: material.compositors[1], programPageToken: material.programPageToken, renderer: rendererBinding, assignment: null });
  return output;
}

export function validateProductionMaterial(value) {
  if (!value || value.schemaVersion !== MATERIAL_SCHEMA_VERSION) throw new Error("production recovery material schema is invalid");
  requireSecret(value.programPageToken, "program-page token", 24);
  requireSecret(value.commentary?.apiKey, "commentary API key", 8);
  requireSecret(value.commentary?.apiSecret, "commentary API secret", 24);
  const streamIds = new Set();
  const streamKeys = new Set();
  for (const court of COURTS) {
    const publisher = value.publishers?.[court];
    requireSecret(publisher?.user, `Camera ${court} publisher user`, 4);
    requireSecret(publisher?.password, `Camera ${court} publisher password`, 16);
    if (publisher.source !== "publisher" && !(typeof publisher.source === "string" && publisher.source.startsWith("srt://"))) throw new Error(`Camera ${court} raw source is invalid`);
    const compositor = value.compositors?.[court];
    requireSecret(compositor?.apiKey, `Camera ${court} compositor API key`, 8);
    requireSecret(compositor?.apiSecret, `Camera ${court} compositor API secret`, 24);
    requireRtmps(compositor?.rtmpsBase, `Camera ${court} YouTube RTMPS base`);
    requireSecret(compositor?.streamKey, `Camera ${court} YouTube stream key`, 8);
    requireProviderId(compositor?.streamId, `Camera ${court} YouTube stream id`);
    if (streamIds.has(compositor.streamId) || streamKeys.has(compositor.streamKey)) throw new Error("production YouTube stream identities are not unique");
    streamIds.add(compositor.streamId);
    streamKeys.add(compositor.streamKey);
    variableYouTubeProfile(compositor ?? {});
  }
  return value;
}

function validateLegacyProductionMaterial(value) {
  if (!value || value.schemaVersion !== LEGACY_MATERIAL_SCHEMA_VERSION) throw new Error("legacy production recovery material schema is invalid");
  requireSecret(value.programPageToken, "program-page token", 24);
  requireSecret(value.commentary?.apiKey, "commentary API key", 8);
  requireSecret(value.commentary?.apiSecret, "commentary API secret", 24);
  for (const court of COURTS) {
    const publisher = value.publishers?.[court];
    requireSecret(publisher?.user, `Camera ${court} publisher user`, 4);
    requireSecret(publisher?.password, `Camera ${court} publisher password`, 16);
    if (publisher.source !== "publisher" && !(typeof publisher.source === "string" && publisher.source.startsWith("srt://"))) throw new Error(`Camera ${court} raw source is invalid`);
    const compositor = value.compositors?.[court];
    requireSecret(compositor?.apiKey, `Camera ${court} compositor API key`, 8);
    requireSecret(compositor?.apiSecret, `Camera ${court} compositor API secret`, 24);
    requireRtmps(compositor?.rtmpsBase, `Camera ${court} YouTube RTMPS base`);
    requireSecret(compositor?.streamKey, `Camera ${court} YouTube stream key`, 8);
    legacyEncodingProfile(compositor?.encoding ?? {});
  }
  return value;
}

function buildRecoveryWebEnvironment({ webEnvironment, monitoringEnvironment, material }) {
  const output = { ...webEnvironment };
  output.PROGRAM_PAGE_TOKEN = material.programPageToken;
  output.MONITOR_API_TOKEN = required(monitoringEnvironment, "MONITOR_API_TOKEN");
  output.MONITOR_BROWSER_HEARTBEAT_SECRET = required(monitoringEnvironment, "MONITOR_BROWSER_HEARTBEAT_SECRET");
  output.MONITOR_PUBLIC_URL = `https://${required(monitoringEnvironment, "MONITOR_PUBLIC_HOST")}`;
  output.MEDIAMTX_RTMP_INGEST_BASE = output.MEDIAMTX_RTMP_INGEST_BASE
    || required(output, "MEDIAMTX_WHEP_BASE_URL").replace(/^https:/, "rtmp:");
  output.LIVEKIT_COMMENTARY_API_KEY = material.commentary.apiKey;
  output.LIVEKIT_COMMENTARY_API_SECRET = material.commentary.apiSecret;
  return Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
}

function filterMonitoringEnvironment(environment) {
  requireEnvironment(environment, REQUIRED_MONITORING_KEYS);
  rejectTwilio(environment);
  return Object.fromEntries(Object.entries(environment)
    .filter(([key]) => !OMITTED_MONITORING_KEYS.has(key))
    .sort(([left], [right]) => left.localeCompare(right)));
}

function variableYouTubeProfile(environment) {
  const outputProfiles = Array.isArray(environment.outputProfiles)
    ? environment.outputProfiles
    : typeof environment.PRODUCTION_OUTPUT_PROFILES === "string"
      ? environment.PRODUCTION_OUTPUT_PROFILES.split(",")
      : [];
  const profile = {
    youtubeResolution: String(environment.YOUTUBE_STREAM_RESOLUTION ?? environment.youtubeResolution ?? ""),
    youtubeFrameRate: String(environment.YOUTUBE_STREAM_FRAME_RATE ?? environment.youtubeFrameRate ?? ""),
    outputProfiles
  };
  const expected = { youtubeResolution: "variable", youtubeFrameRate: "variable", outputProfiles: PRODUCTION_OUTPUT_PROFILES };
  if (stableJson(profile) !== stableJson(expected)) throw new Error("compositor YouTube destination is not the variable-profile 1080p30/60 contract");
  return { youtubeResolution: profile.youtubeResolution, youtubeFrameRate: profile.youtubeFrameRate, outputProfiles: [...PRODUCTION_OUTPUT_PROFILES] };
}

function legacyEncodingProfile(value) {
  const profile = Object.fromEntries(Object.entries(value ?? {}).map(([key, entry]) => [key, String(entry)]));
  const expected = { width: "1280", height: "720", framerate: "30", videoBitrate: "4000", audioBitrate: "128", audioFrequency: "48000", keyframeInterval: "2" };
  if (stableJson(profile) !== stableJson(expected)) throw new Error("legacy compositor encoding profile is not the qualified 720p30 contract");
  return profile;
}

function compositorEnvironment({ court, compositor, programPageToken, renderer, assignment }) {
  const normalizerEnabled = assignment?.sourcePathMode === "isolated-hevc-normalizer";
  const values = {
    LIVEKIT_API_KEY: compositor.apiKey,
    LIVEKIT_API_SECRET: compositor.apiSecret,
    LIVEKIT_URL: "http://127.0.0.1:7880",
    PROGRAM_PAGE_BASE_URL: `${renderer.origin}/program`,
    PROGRAM_PAGE_TOKEN: programPageToken,
    PROGRAM_RENDERER_GIT_SHA: renderer.gitSha,
    PROGRAM_RENDERER_DEPLOYMENT_ID: renderer.deploymentId,
    YOUTUBE_RTMPS_BASE: compositor.rtmpsBase,
    YOUTUBE_STREAM_RESOLUTION: compositor.youtubeResolution,
    YOUTUBE_STREAM_FRAME_RATE: compositor.youtubeFrameRate,
    PRODUCTION_OUTPUT_PROFILES: compositor.outputProfiles.join(","),
    ...(court ? {
      CAMERA_NUMBER: String(court),
      CAMERA_SOURCE_PATH_MODE: assignment?.sourcePathMode ?? "inactive",
      CAMERA_SOURCE_CODEC: assignment?.sourceCodec ?? "NONE",
      CAMERA_SOURCE_PROFILE: assignment?.sourceProfile ?? "NONE",
      CAMERA_FRAME_RATE_MODE: assignment?.frameRateMode ?? "NONE",
      CAMERA_NORMALIZER_ENABLED: normalizerEnabled ? "true" : "false",
      CAMERA_NORMALIZER_INPUT_PATH: `court${court}_raw`,
      CAMERA_NORMALIZER_OUTPUT_PATH: `court${court}_normalized`,
      [`COURT_${court}_YOUTUBE_KEY`]: compositor.streamKey,
      [`COURT_${court}_YOUTUBE_STREAM_ID`]: compositor.streamId
    } : {})
  };
  return envFile(values);
}

async function verifyProtectedCapture(rootValue) {
  const root = normalizedAbsolute(rootValue, "reconstruction capture");
  await assertProtectedDirectory(root, "reconstruction capture");
  const capture = await readProtectedJson(join(root, "CAPTURE.json"), "reconstruction capture marker");
  if (capture.schemaVersion !== 1 || capture.containsSecrets !== true) throw new Error("reconstruction capture marker is invalid");
  const checksumsPath = join(root, "SHA256SUMS");
  await assertProtectedFile(checksumsPath, "reconstruction checksums");
  const rows = (await readFile(checksumsPath, "utf8")).split(/\r?\n/).filter(Boolean);
  if (rows.length < 10) throw new Error("reconstruction checksum inventory is incomplete");
  const names = new Set();
  for (const row of rows) {
    const match = row.match(/^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/);
    if (!match) throw new Error("reconstruction checksum inventory is invalid");
    const [, expected, name] = match;
    validateRelativeFile(name);
    if (names.has(name)) throw new Error("reconstruction checksum inventory contains duplicates");
    names.add(name);
    const path = join(root, name);
    await assertProtectedFile(path, `reconstruction capture ${name}`);
    if (sha256(await readFile(path)) !== expected) throw new Error(`reconstruction capture ${name} failed integrity verification`);
  }
}

function capturePaths(root) {
  return {
    ingestConfig: join(root, "live/ingest-config.json"),
    ingestPathConfig: join(root, "live/ingest-path-config.json"),
    webEnvironment: join(root, "local/web.env"),
    monitoringEnvironment: join(root, "local/monitoring.env"),
    compositorEnvironments: ["a", "b", "c", "d"].map((name) => join(root, `expanded/compositor-${name}/opt/compositor/.env`)),
    wireguard: join(root, "expanded/ingest/etc/wireguard")
  };
}

async function verifyRenderedDirectory(root, inputSha256) {
  await assertProtectedDirectory(root, "production secret directory");
  const marker = await readProtectedJson(join(root, "RENDER_COMPLETE.json"), "production secret marker");
  if (marker.schemaVersion !== 1 || marker.inputSha256 !== inputSha256 || !marker.files || typeof marker.files !== "object") throw new Error("production secret marker is invalid");
  for (const [name, expected] of Object.entries(marker.files)) {
    validateRelativeFile(name);
    await assertProtectedFile(join(root, name), `production secret ${name}`);
    if (sha256(await readFile(join(root, name))) !== expected) throw new Error(`production secret ${name} failed integrity verification`);
  }
}

async function hashesForFiles(root, names) {
  return Object.fromEntries(await Promise.all([...names].sort().map(async (name) => [name, sha256(await readFile(join(root, name)))])));
}

async function readProtectedJson(path, label) {
  await assertProtectedFile(path, label);
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

async function assertProtectedFile(path, label) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a mode-0600 protected file`);
}

async function assertProtectedDirectory(path, label) {
  const information = await stat(path);
  if (!information.isDirectory() || (information.mode & 0o077) !== 0) throw new Error(`${label} must be a mode-0700 protected directory`);
}

async function assertProtectedParent(path) {
  await assertProtectedDirectory(dirname(path), "production recovery parent");
}

async function assertAbsent(path, label) {
  try { await stat(path); throw new Error(`${label} already exists`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}

function parseArgs(argv) {
  const command = argv[0];
  if ([undefined, "help", "-h", "--help"].includes(command)) return null;
  if (!new Set(["capture", "migrate-youtube", "verify"]).has(command)) throw new Error("command must be capture, migrate-youtube, or verify");
  const options = { command, captureRoot: null, output: null, source: null, destinations: null };
  const mapping = new Map([["--capture-root", "captureRoot"], ["--output", "output"], ["--source", "source"], ["--destinations", "destinations"]]);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = mapping.get(flag);
    const value = argv[++index];
    if (!key || !value || value.startsWith("--")) throw new Error(`${flag} is unknown or missing a value`);
    options[key] = normalizedAbsolute(value, flag);
  }
  if (command === "capture" && (!options.captureRoot || !options.output || options.source || options.destinations)) throw new Error("capture requires --capture-root and --output");
  if (command === "migrate-youtube" && (!options.source || !options.destinations || !options.output || options.captureRoot)) throw new Error("migrate-youtube requires --source, --destinations, and --output");
  if (command === "verify" && (!options.source || options.captureRoot || options.output || options.destinations)) throw new Error("verify requires --source");
  return options;
}

function usage() {
  process.stdout.write("Usage:\n  node infra/event-stack/production-recovery.mjs capture --capture-root /PROTECTED/CAPTURE --output /PROTECTED/SOURCE\n  node infra/event-stack/production-recovery.mjs migrate-youtube --source /PROTECTED/V1-SOURCE --destinations /PROTECTED/destinations.json --output /PROTECTED/V2-SOURCE\n  node infra/event-stack/production-recovery.mjs verify --source /PROTECTED/SOURCE\n");
}

function envFile(values) {
  return Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join("\n") + "\n";
}

function requireEnvironment(environment, names) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("environment is invalid");
  for (const name of names) required(environment, name);
}

function required(environment, name) {
  const value = environment?.[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireSecret(value, label, minimum) {
  if (typeof value !== "string" || value.length < minimum || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireRtmps(value, label) {
  if (typeof value !== "string" || !value.startsWith("rtmps://") || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireProviderId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{3,100}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function rejectTwilio(environment) {
  const keys = Object.keys(environment ?? {}).filter((key) => key.startsWith("TWILIO_"));
  if (keys.length) throw new Error("production monitoring recovery source must not contain Twilio credentials");
}

function validateRelativeFile(value) {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.startsWith("/") || value.includes("..") || value.includes("//")) throw new Error("protected source path is invalid");
}

function normalizedAbsolute(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || value.includes("..") || /[\r\n\0]/.test(value)) throw new Error(`${label} must be a normalized absolute path`);
  return value;
}

function unique(values) { return [...new Set(values)]; }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function writeProtected(path, body) { await writeFile(path, body, { flag: "wx", mode: 0o600 }); await chmod(path, 0o600); }

export { COURTS, REQUIRED_MONITORING_KEYS };
