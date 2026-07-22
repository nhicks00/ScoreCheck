import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const COURTS = Object.freeze(Array.from({ length: 8 }, (_, index) => index + 1));
const SECRET_SCHEMA_VERSION = 2;

export function createRehearsalSecretMaterial({ random = randomBytes } = {}) {
  const secret = (bytes = 32) => random(bytes).toString("base64url");
  return {
    schemaVersion: SECRET_SCHEMA_VERSION,
    programPageToken: secret(),
    adminSecret: secret(),
    commentatorPasscode: secret(18),
    monitorApiToken: secret(),
    alertmanagerWebhookToken: secret(),
    browserHeartbeatSecret: secret(),
    commentary: { apiKey: `SC${secret(12)}`, apiSecret: secret(36), roomPrefix: `scorecheck-rehearsal-${secret(6)}-` },
    publishers: Object.fromEntries(COURTS.map((court) => [court, { user: `camera${court}-${secret(8)}`, password: secret(32) }])),
    compositors: Object.fromEntries(COURTS.map((court) => [court, { apiKey: `SC${secret(12)}`, apiSecret: secret(36) }])),
    agents: {}
  };
}

export function completeAgentSecrets(material, manifest, { random = randomBytes } = {}) {
  validateSecretMaterial(material);
  const expected = manifest.droplets.map((entry) => entry.name).sort();
  const existing = Object.keys(material.agents).sort();
  if (existing.length && JSON.stringify(existing) !== JSON.stringify(expected)) {
    throw new Error("rehearsal agent token ownership does not match the manifest");
  }
  if (!existing.length) {
    for (const name of expected) material.agents[name] = random(32).toString("base64url");
  }
  return material;
}

export function buildRehearsalVercelEnvironment({ manifest, material, programOrigin }) {
  validateRehearsalInputs({ manifest, material, programOrigin });
  const ingestHost = endpointForRole(manifest, "ingest");
  const monitorHost = endpointForRole(manifest, "observability");
  const commentaryHosts = commentaryEndpointHosts(manifest);
  return {
    PROGRAM_PAGE_TOKEN: material.programPageToken,
    ADMIN_SECRET: material.adminSecret,
    COMMENTATOR_PASSCODE: material.commentatorPasscode,
    MEDIAMTX_WHEP_BASE_URL: `https://${ingestHost}`,
    MONITOR_PUBLIC_URL: `https://${monitorHost}`,
    MONITOR_BROWSER_HEARTBEAT_SECRET: material.browserHeartbeatSecret,
    NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL: `wss://${commentaryHosts.rtc}`,
    LIVEKIT_COMMENTARY_API_KEY: material.commentary.apiKey,
    LIVEKIT_COMMENTARY_API_SECRET: material.commentary.apiSecret,
    LIVEKIT_COMMENTARY_ROOM_PREFIX: material.commentary.roomPrefix,
    NEXT_PUBLIC_SCORECHECK_REHEARSAL: "true",
    SCORECHECK_REHEARSAL_ORIGIN: programOrigin
  };
}

export async function renderRehearsalSecretDirectory({ manifest, material, directory, renderer, youtubeDestinations, external = {} }) {
  validateRehearsalInputs({ manifest, material, programOrigin: renderer?.origin });
  validateRenderer(renderer);
  completeAgentSecrets(material, manifest);
  validateYoutubeDestinations(youtubeDestinations);
  const target = resolve(directory);
  const inputSha256 = sha256(stableJson({ manifest, material, renderer, youtubeDestinations, external }));
  if (await exists(target)) {
    await verifyRenderedDirectory(target, inputSha256);
    return target;
  }
  const root = `${target}.rendering`;
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "compositors"), { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(join(root, "compositors"), 0o700);

  try {
    await writeProtected(join(root, "material.json"), JSON.stringify(material, null, 2) + "\n");
    await writeProtected(join(root, "agent-tokens.json"), JSON.stringify({ schemaVersion: 1, tokens: material.agents }, null, 2) + "\n");
    await writeProtected(join(root, "commentary.env"), envFile({
      LIVEKIT_COMMENTARY_API_KEY: material.commentary.apiKey,
      LIVEKIT_COMMENTARY_API_SECRET: material.commentary.apiSecret
    }));
    await writeProtected(join(root, "ingest.env"), envFile(Object.fromEntries([
      ["MEDIAMTX_PROGRAM_DELAY_MS", "3500"],
      ...COURTS.flatMap((court) => [
        [`MEDIAMTX_COURT_${court}_RAW_SOURCE`, "publisher"],
        [`MEDIAMTX_COURT_${court}_BROWSER_SOURCE`, "raw"],
        [`MEDIAMTX_COURT_${court}_PUBLISH_USER`, material.publishers[court].user],
        [`MEDIAMTX_COURT_${court}_PUBLISH_PASS`, material.publishers[court].password]
      ])
    ])));

  const observer = {
    MONITOR_API_TOKEN: material.monitorApiToken,
    ALERTMANAGER_WEBHOOK_TOKEN: material.alertmanagerWebhookToken,
    MONITOR_BROWSER_HEARTBEAT_SECRET: material.browserHeartbeatSecret,
    MONITOR_BROWSER_ALLOWED_ORIGINS: renderer.origin,
    MONITOR_DASHBOARD_URL: `${renderer.origin}/admin/monitor`,
    MONITOR_COURT_COUNT: "8",
    ...(external.pushoverAppToken && external.pushoverUserKey ? {
      PUSHOVER_APP_TOKEN: external.pushoverAppToken,
      PUSHOVER_USER_KEY: external.pushoverUserKey
    } : {}),
    ...(external.youtubeClientId && external.youtubeClientSecret && external.youtubeRefreshToken ? {
      YOUTUBE_CLIENT_ID: external.youtubeClientId,
      YOUTUBE_CLIENT_SECRET: external.youtubeClientSecret,
      YOUTUBE_REFRESH_TOKEN: external.youtubeRefreshToken
    } : {})
  };
  if (Object.keys(observer).some((key) => key.startsWith("SUPABASE_") || key.startsWith("HEALTHCHECKS_"))) {
    throw new Error("rehearsal observability must not bind production Supabase or Healthchecks");
  }
    await writeProtected(join(root, "observability.env"), envFile(observer));

    for (const court of COURTS) {
      const spec = manifest.droplets.find((entry) => entry.role === "compositor" && entry.court === court);
      if (!spec) throw new Error(`rehearsal manifest has no compositor for Camera ${court}`);
      const destination = youtubeDestinations.find((entry) => entry.court === court);
      await writeProtected(join(root, "compositors", `${spec.name}.env`), envFile({
        LIVEKIT_API_KEY: material.compositors[court].apiKey,
        LIVEKIT_API_SECRET: material.compositors[court].apiSecret,
        LIVEKIT_URL: "http://127.0.0.1:7880",
        PROGRAM_PAGE_BASE_URL: `${renderer.origin}/program`,
        PROGRAM_PAGE_TOKEN: material.programPageToken,
        PROGRAM_RENDERER_GIT_SHA: renderer.gitSha,
        PROGRAM_RENDERER_DEPLOYMENT_ID: renderer.deploymentId,
        CAMERA_NUMBER: String(court),
        CAMERA_SOURCE_PATH_MODE: "direct-h264",
        CAMERA_SOURCE_CODEC: "H264",
        CAMERA_SOURCE_PROFILE: "STANDARD_1080P30",
        CAMERA_FRAME_RATE_MODE: "30/1",
        CAMERA_NORMALIZER_ENABLED: "false",
        CAMERA_NORMALIZER_INPUT_PATH: `court${court}_raw`,
        CAMERA_NORMALIZER_OUTPUT_PATH: `court${court}_normalized`,
        YOUTUBE_RTMPS_BASE: destination.rtmpsIngestionAddress,
        [`COURT_${court}_YOUTUBE_KEY`]: destination.streamName
      }));
    }

    const spare = manifest.droplets.find((entry) => entry.role === "compositor-spare");
    if (!spare) throw new Error("rehearsal manifest has no warm spare");
    const spareKeys = material.compositors[1];
    await writeProtected(join(root, "compositors", `${spare.name}.env`), envFile({
      LIVEKIT_API_KEY: spareKeys.apiKey,
      LIVEKIT_API_SECRET: spareKeys.apiSecret,
      LIVEKIT_URL: "http://127.0.0.1:7880",
      PROGRAM_PAGE_BASE_URL: `${renderer.origin}/program`,
      PROGRAM_PAGE_TOKEN: material.programPageToken,
      PROGRAM_RENDERER_GIT_SHA: renderer.gitSha,
      PROGRAM_RENDERER_DEPLOYMENT_ID: renderer.deploymentId,
      YOUTUBE_RTMPS_BASE: "rtmps://a.rtmps.youtube.com/live2"
    }));
    const files = ["material.json", "agent-tokens.json", "commentary.env", "ingest.env", "observability.env",
      ...manifest.droplets.filter((entry) => ["compositor", "compositor-spare"].includes(entry.role)).map((entry) => `compositors/${entry.name}.env`).sort()];
    const marker = {
      schemaVersion: 1,
      inputSha256,
      files: Object.fromEntries(await Promise.all(files.map(async (name) => [name, sha256(await readFile(join(root, name)))])))
    };
    await writeProtected(join(root, "RENDER_COMPLETE.json"), `${JSON.stringify(marker, null, 2)}\n`);
    await rename(root, target);
    await chmod(target, 0o700);
    return target;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function loadProtectedSecretMaterial(path) {
  const information = await stat(path);
  if (!information.isFile() || (information.mode & 0o077) !== 0) throw new Error("rehearsal secret material must be mode 0600 or stricter");
  const value = JSON.parse(await readFile(path, "utf8"));
  validateSecretMaterial(value);
  return value;
}

export function validateSecretMaterial(value) {
  if (!value || value.schemaVersion !== SECRET_SCHEMA_VERSION) throw new Error("rehearsal secret material schema is invalid");
  for (const key of ["programPageToken", "adminSecret", "commentatorPasscode", "monitorApiToken", "alertmanagerWebhookToken", "browserHeartbeatSecret"]) requireSecret(value[key], key);
  requireSecret(value.commentary?.apiKey, "commentary api key", 12);
  requireSecret(value.commentary?.apiSecret, "commentary api secret");
  requireSecret(value.commentary?.roomPrefix, "commentary room prefix", 12);
  for (const court of COURTS) {
    requireSecret(value.publishers?.[court]?.user, `Camera ${court} publisher user`, 12);
    requireSecret(value.publishers?.[court]?.password, `Camera ${court} publisher password`);
    requireSecret(value.compositors?.[court]?.apiKey, `Camera ${court} compositor key`, 12);
    requireSecret(value.compositors?.[court]?.apiSecret, `Camera ${court} compositor secret`);
  }
  if (!value.agents || typeof value.agents !== "object" || Array.isArray(value.agents)) throw new Error("rehearsal agent secrets are invalid");
  return value;
}

function validateRehearsalInputs({ manifest, material, programOrigin }) {
  if (manifest?.kind !== "rehearsal" || manifest?.droplets?.length !== 12) throw new Error("rehearsal secrets require the isolated 12-Droplet manifest");
  validateSecretMaterial(material);
  const parsed = new URL(programOrigin);
  if (parsed.protocol !== "https:" || parsed.origin !== programOrigin || parsed.hostname === "score.beachvolleyballmedia.com" || parsed.hostname === "www.beachvolleyballmedia.com") {
    throw new Error("rehearsal program origin must be an isolated HTTPS origin");
  }
}

function validateRenderer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rehearsal renderer binding is required");
  const parsed = new URL(value.origin);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vercel.app") || parsed.origin !== value.origin) {
    throw new Error("rehearsal renderer origin must be an immutable generated Vercel origin");
  }
  if (!/^dpl_[A-Za-z0-9]+$/.test(value.deploymentId ?? "")) throw new Error("rehearsal renderer deployment id is invalid");
  if (!/^[a-f0-9]{40}$/.test(value.gitSha ?? "")) throw new Error("rehearsal renderer Git SHA is invalid");
}

function validateYoutubeDestinations(values) {
  if (!Array.isArray(values) || values.length !== 8 || new Set(values.map((entry) => entry.court)).size !== 8) {
    throw new Error("rehearsal requires exactly eight persistent YouTube ingest streams");
  }
  for (const destination of values) {
    if (!COURTS.includes(destination.court)
      || destination.mode !== "persistent-youtube-stream-ingest-v1"
      || destination.title !== `ScoreCheck Production Camera ${destination.court} Auto Stream`
      || destination.isReusable !== true
      || !destination.streamId
      || !destination.streamName
      || !destination.rtmpsIngestionAddress?.startsWith("rtmps://")) {
      throw new Error("rehearsal YouTube destination is invalid");
    }
  }
}

function endpointForRole(manifest, role) {
  const values = manifest.endpoints.filter((entry) => entry.role === role);
  if (values.length !== 1) throw new Error(`rehearsal manifest must have one ${role} endpoint`);
  return values[0].hostname;
}

function commentaryEndpointHosts(manifest) {
  const role = manifest.endpoints.filter((entry) => entry.role === "commentary");
  const rtc = role.find((entry) => entry.hostname.split(".")[0].startsWith("rtc-"));
  const turn = role.find((entry) => entry.hostname.split(".")[0].startsWith("turn-"));
  if (!rtc || !turn) throw new Error("rehearsal commentary endpoints are incomplete");
  return { rtc: rtc.hostname, turn: turn.hostname };
}

async function writeProtected(path, body) {
  await writeFile(path, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

async function verifyRenderedDirectory(root, inputSha256) {
  const directory = await stat(root);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error("existing rehearsal secret directory is not protected");
  let marker;
  try { marker = JSON.parse(await readFile(join(root, "RENDER_COMPLETE.json"), "utf8")); }
  catch (error) { throw new Error(`existing rehearsal secret directory is incomplete: ${error?.code ?? "invalid marker"}`); }
  if (marker.schemaVersion !== 1 || marker.inputSha256 !== inputSha256 || !marker.files || typeof marker.files !== "object") throw new Error("existing rehearsal secret directory belongs to different inputs");
  for (const [name, expected] of Object.entries(marker.files)) {
    if (!/^(?:[a-z0-9-]+\.env|[a-z0-9-]+\.json|compositors\/[a-z0-9-]+\.env)$/.test(name) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("existing rehearsal secret marker is invalid");
    const file = await stat(join(root, name));
    if (!file.isFile() || (file.mode & 0o077) !== 0 || sha256(await readFile(join(root, name))) !== expected) throw new Error(`existing rehearsal secret file ${name} failed integrity verification`);
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function envFile(values) {
  return Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join("\n") + "\n";
}

function requireSecret(value, label, minimum = 24) {
  if (typeof value !== "string" || value.length < minimum || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export { COURTS };
