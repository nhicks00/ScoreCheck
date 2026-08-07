import test from "node:test";
import assert from "node:assert/strict";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { deriveOpaqueRtmpKey } from "../mediamtx/opaque-rtmp-key.mjs";
import { buildProductionMaterial, buildProductionSecretFiles, derivedMediaReadCredentials, migrateMonitoringEnvironment, migrateProductionMaterial, migrateWebRuntimeEnvironment, replaceProductionDestinations } from "./production-recovery.mjs";
import { createSyntheticRehearsalVenueProfile } from "./venue-admission.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "production-recovery-test", kind: "production", destroyAfter: "2026-08-01", ...inputs });
const venueProfile = createSyntheticRehearsalVenueProfile(manifest.event);
venueProfile.cameras[1] = {
  ...venueProfile.cameras[1],
  sourcePathMode: "isolated-browser-normalizer",
  sourceCodec: "H265"
};
venueProfile.cameras[2] = {
  ...venueProfile.cameras[2],
  sourceProtocol: "RTMP_LEGACY_APPROVED",
  legacyTransportApproved: true
};
const renderer = {
  schemaVersion: 1,
  provider: "vercel",
  origin: "https://scorecheck-abc123-team.vercel.app",
  deploymentId: "dpl_renderer123",
  gitSha: "a".repeat(40),
  assetNamespace: "dpl_renderer123",
  contracts: {
    programSession: "program-session-v1",
    overlayState: "overlay-state-v1",
    commentary: "commentary-v1",
    browserHeartbeat: "browser-heartbeat-v6"
  }
};

function fixture() {
  const globalConfig = {
    authInternalUsers: Array.from({ length: 8 }, (_, index) => ({
      user: `camera-${index + 1}`,
      pass: `publisher-password-${index + 1}-abcdefghijklmnopqrstuvwxyz`,
      permissions: [{ action: "publish", path: `court${index + 1}_raw` }]
    }))
  };
  const pathConfig = {
    items: Array.from({ length: 8 }, (_, index) => ({
      name: `court${index + 1}_raw`,
      source: index < 5 ? "publisher" : `srt://10.89.0.${index + 1}:10${index + 1}?mode=caller`
    }))
  };
  const webEnvironment = {
    LIVEKIT_COMMENTARY_API_KEY: "commentary-key-123",
    LIVEKIT_COMMENTARY_API_SECRET: "commentary-secret-abcdefghijklmnopqrstuvwxyz",
    MEDIAMTX_HLS_BASE_URL: "https://preview.example.test",
    MEDIAMTX_WHEP_BASE_URL: "https://preview.example.test",
    MONITOR_BROWSER_HEARTBEAT_SECRET: "monitor-browser-secret-abcdefghijklmnopqrstuvwxyz",
    MONITOR_PUBLIC_URL: "https://monitor.example.test",
    NEXT_PUBLIC_LIVEKIT_COMMENTARY_URL: "wss://rtc.example.test",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-abcdefghijklmnopqrstuvwxyz",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    PROGRAM_PAGE_TOKEN: "program-page-token-abcdefghijklmnopqrstuvwxyz",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-abcdefghijklmnopqrstuvwxyz"
  };
  const monitoringEnvironment = Object.fromEntries([
    "ALERTMANAGER_WEBHOOK_TOKEN", "HEALTHCHECKS_ACTIVE_CHECK_ID", "HEALTHCHECKS_ACTIVE_PING_URL", "HEALTHCHECKS_API_KEY",
    "HEALTHCHECKS_BASELINE_CHECK_ID", "HEALTHCHECKS_BASELINE_PING_URL", "HEALTHCHECKS_SENTINEL_PING_URL", "MONITOR_API_TOKEN", "MONITOR_BROWSER_ALLOWED_ORIGINS",
    "MONITOR_BROWSER_HEARTBEAT_SECRET", "MONITOR_DASHBOARD_URL", "MONITOR_PUBLIC_HOST", "PUSHOVER_APP_TOKEN", "PUSHOVER_USER_KEY",
    "MONITOR_PEPLINK_CAMERA_SSID", "MONITOR_PEPLINK_CLIENT_ID", "MONITOR_PEPLINK_CLIENT_SECRET", "MONITOR_PEPLINK_DEVICE_ID",
    "MONITOR_PEPLINK_FIRMWARE_VERSION", "MONITOR_PEPLINK_GROUP_ID", "MONITOR_PEPLINK_HARDWARE_VERSION", "MONITOR_PEPLINK_ORGANIZATION_ID",
    "MONITOR_PEPLINK_PRODUCT_CODE", "MONITOR_PEPLINK_SPEEDFUSION_PROFILE_NAME", "MONITOR_PEPLINK_WANS_JSON",
    "MONITOR_NETWORK_SWITCH_EXPORTER_URL", "MONITOR_NETWORK_SWITCH_FIRMWARE_VERSION", "MONITOR_NETWORK_SWITCH_MODEL", "MONITOR_NETWORK_SWITCH_PORTS_JSON",
    "MONITOR_NETWORK_SWITCH_REQUIRED", "MONITOR_NETWORK_SWITCH_TARGET", "MONITOR_UNIFI_ACCESS_POINTS_JSON", "MONITOR_UNIFI_CAMERA_CLIENTS_JSON", "MONITOR_UNIFI_API_KEY", "MONITOR_UNIFI_BASE_URL",
    "MONITOR_UNIFI_REQUIRED", "MONITOR_UNIFI_SITE_ID", "LINOVISION_SNMP_AUTH_PASSWORD", "LINOVISION_SNMP_PRIV_PASSWORD", "LINOVISION_SNMP_USER",
    "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"
  ].map((key) => [key, `${key.toLowerCase()}-abcdefghijklmnopqrstuvwxyz`]));
  monitoringEnvironment.HEALTHCHECKS_BASELINE_PING_URL = "https://hc-ping.com/monitor-baseline";
  monitoringEnvironment.HEALTHCHECKS_ACTIVE_PING_URL = "https://hc-ping.com/monitor-active";
  monitoringEnvironment.HEALTHCHECKS_SENTINEL_PING_URL = "https://hc-ping.com/platform-sentinel";
  monitoringEnvironment.MONITOR_PEPLINK_PRODUCT_CODE = "MAX-BR1-PRO-5GK-T-PRM";
  monitoringEnvironment.MONITOR_PEPLINK_HARDWARE_VERSION = "3";
  monitoringEnvironment.MONITOR_PEPLINK_FIRMWARE_VERSION = "8.6.0 build 6450";
  monitoringEnvironment.MONITOR_PEPLINK_SPEEDFUSION_PROFILE_NAME = "SFC-SFO";
  monitoringEnvironment.MONITOR_PEPLINK_CAMERA_SSID = "BVM";
  monitoringEnvironment.MONITOR_PEPLINK_WANS_JSON = '[{"id":1,"name":"WAN","required":true},{"id":2,"name":"Cellular","required":true}]';
  monitoringEnvironment.MONITOR_AGENT_TARGETS = "old-target-must-not-survive";
  const compositorEnvironments = Array.from({ length: 4 }, (_, index) => {
    const firstCourt = (index * 2) + 1;
    return {
      LIVEKIT_API_KEY: `local-key-${index}-1234567890`,
      LIVEKIT_API_SECRET: `local-secret-${index}-abcdefghijklmnopqrstuvwxyz`,
      PROGRAM_PAGE_TOKEN: "program-page-token-abcdefghijklmnopqrstuvwxyz",
      YOUTUBE_RTMPS_BASE: "rtmps://a.rtmps.youtube.com/live2",
      YOUTUBE_STREAM_RESOLUTION: "variable",
      YOUTUBE_STREAM_FRAME_RATE: "variable",
      PRODUCTION_OUTPUT_PROFILES: "1080p30,1080p60",
      [`COURT_${firstCourt}_YOUTUBE_KEY`]: `youtube-key-${firstCourt}-abcdefghijk`,
      [`COURT_${firstCourt}_YOUTUBE_STREAM_ID`]: `youtube-stream-${firstCourt}`,
      [`COURT_${firstCourt + 1}_YOUTUBE_KEY`]: `youtube-key-${firstCourt + 1}-abcdefghijk`,
      [`COURT_${firstCourt + 1}_YOUTUBE_STREAM_ID`]: `youtube-stream-${firstCourt + 1}`
    };
  });
  return { globalConfig, pathConfig, webEnvironment, monitoringEnvironment, compositorEnvironments };
}

function destinationFixture(prefix = "production") {
  return {
    schemaVersion: 1,
    streams: Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
      const court = index + 1;
      return [court, {
        id: `${prefix}-stream-${court}`,
        court,
        resolution: "variable",
        frameRate: "variable",
        streamName: `${prefix}-stream-key-${court}`,
        rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2",
        rtmpsBackupIngestionAddress: "rtmps://b.rtmps.youtube.com/live2"
      }];
    }))
  };
}

test("normalizes all eight stable camera and output identities without a live Droplet dependency", () => {
  const material = buildProductionMaterial(fixture());
  assert.equal(Object.keys(material.publishers).length, 8);
  assert.equal(Object.keys(material.compositors).length, 8);
  assert.equal(material.publishers[1].source, "publisher");
  assert.match(material.publishers[8].source, /^srt:\/\//);
  assert.equal(material.compositors[7].streamKey, "youtube-key-7-abcdefghijk");
  assert.equal(material.compositors[7].streamId, "youtube-stream-7");
  assert.deepEqual(material.compositors[7].outputProfiles, ["1080p30", "1080p60"]);
  assert.equal(material.programPageToken, "program-page-token-abcdefghijklmnopqrstuvwxyz");
});

test("renders the exact 12-host production secret contract and strips stale target ownership", () => {
  const values = fixture();
  const material = buildProductionMaterial(values);
  const agentTokens = Object.fromEntries(manifest.droplets.map((spec, index) => [spec.name, `agent-${index}-abcdefghijklmnopqrstuvwxyz123456`]));
  const files = buildProductionSecretFiles({
    manifest,
    material,
    monitoringEnvironment: values.monitoringEnvironment,
    webEnvironment: values.webEnvironment,
    renderer,
    localRendererSha256: "c".repeat(64),
    venueProfile,
    agentTokens
  });
  assert.equal(Object.keys(files).filter((name) => name.startsWith("compositors/")).length, 9);
  assert.match(files["ingest.env"], /MEDIAMTX_COURT_8_RAW_SOURCE="publisher"/);
  assert.match(files["ingest.env"], /MEDIAMTX_COURT_1_BROWSER_SOURCE="raw"/);
  assert.match(files["ingest.env"], /MEDIAMTX_COURT_2_BROWSER_SOURCE="normalized"/);
  const expectedCamera3Key = deriveOpaqueRtmpKey({
    court: 3,
    user: material.publishers[3].user,
    password: material.publishers[3].password
  });
  assert.match(files["ingest.env"], new RegExp(`^MEDIAMTX_COURT_3_RTMP_PUBLISH_KEY="${expectedCamera3Key}"$`, "mu"));
  assert.doesNotMatch(files["ingest.env"], /MEDIAMTX_COURT_(?:1|2|4|5|6|7|8)_RTMP_PUBLISH_KEY/u);
  assert.doesNotMatch(files["observability.env"], /MONITOR_AGENT_TARGETS/);
  assert.doesNotMatch(files["observability.env"], /TWILIO_/);
  assert.doesNotMatch(files["observability.env"], /MONITOR_ROUTER_HEARTBEAT_TOKEN=/);
  assert.match(files["observability.env"], /MONITOR_PEPLINK_CLIENT_ID=/);
  assert.match(files["compositors/bvm-compositor-h.env"], /COURT_8_YOUTUBE_KEY=/);
  assert.match(files["compositors/bvm-compositor-h.env"], /COURT_8_YOUTUBE_STREAM_ID=/);
  assert.match(files["compositors/bvm-compositor-h.env"], /YOUTUBE_STREAM_RESOLUTION="variable"/);
  assert.match(files["compositors/bvm-compositor-h.env"], /PRODUCTION_OUTPUT_PROFILES="1080p30,1080p60"/);
  assert.match(files["compositors/bvm-compositor-h.env"], /PROGRAM_PAGE_BASE_URL="http:\/\/renderer:3000\/program"/);
  assert.match(files["compositors/bvm-compositor-h.env"], /PROGRAM_RENDERER_RELEASE_ORIGIN="https:\/\/scorecheck-abc123-team\.vercel\.app"/);
  assert.match(files["compositors/bvm-compositor-h.env"], /PROGRAM_RENDERER_BUNDLE_SHA256="c{64}"/);
  assert.match(files["compositors/bvm-compositor-h.env"], /PROGRAM_RENDERER_DEPLOYMENT_ID="dpl_renderer123"/);
  assert.match(files["compositors/bvm-compositor-b.env"], /CAMERA_NORMALIZER_ENABLED="true"/);
  assert.match(files["compositors/bvm-compositor-b.env"], /CAMERA_SOURCE_CODEC="H265"/);
  assert.match(files["compositors/bvm-compositor-a.env"], /CAMERA_NORMALIZER_ENABLED="false"/);
  assert.match(files["observability.env"], /MONITOR_BROWSER_ALLOWED_ORIGINS="https:\/\/scorecheck-abc123-team\.vercel\.app,http:\/\/renderer:3000"/);
  assert.match(files["renderer.env"], /SCORECHECK_LOCAL_RENDERER="true"/);
  assert.match(files["renderer.env"], /SCORECHECK_PROGRAM_CACHE_DIR="\/var\/lib\/scorecheck-renderer"/);
  const mediaReader = derivedMediaReadCredentials(material.programPageToken);
  for (const path of ["ingest.env", "renderer.env", "compositors/bvm-compositor-a.env", "compositors/bvm-compositor-spare.env"]) {
    assert.match(files[path], new RegExp(`^MEDIAMTX_READ_USER="${mediaReader.user}"$`, "mu"));
    assert.match(files[path], new RegExp(`^MEDIAMTX_READ_PASS="${mediaReader.password}"$`, "mu"));
  }
  assert.match(files["observability.env"], /HEALTHCHECKS_SENTINEL_PING_URL=/);
  assert.doesNotMatch(files["compositors/bvm-compositor-h.env"], /EGRESS_(WIDTH|HEIGHT|FRAMERATE|VIDEO_BITRATE)/);
  assert.doesNotMatch(files["compositors/bvm-compositor-h.env"], /COURT_7_YOUTUBE_KEY=/);
  assert.doesNotMatch(files["compositors/bvm-compositor-spare.env"], /COURT_[1-8]_YOUTUBE_KEY=/);
  assert.doesNotMatch(files["compositors/bvm-compositor-spare.env"], /CAMERA_NUMBER=/);
});

test("keeps inactive camera ingress idle instead of polling stale recovery pulls", () => {
  const values = fixture();
  const material = buildProductionMaterial(values);
  const agentTokens = Object.fromEntries(manifest.droplets.map((spec, index) => [spec.name, `agent-${index}-abcdefghijklmnopqrstuvwxyz123456`]));
  const sixCameraProfile = createSyntheticRehearsalVenueProfile(manifest.event);
  sixCameraProfile.cameras[6] = { cameraNumber: 7, cameraIdentity: "camera-7", publishPath: "court7_raw", enabled: false };
  sixCameraProfile.cameras[7] = { cameraNumber: 8, cameraIdentity: "camera-8", publishPath: "court8_raw", enabled: false };
  const files = buildProductionSecretFiles({
    manifest,
    material,
    monitoringEnvironment: values.monitoringEnvironment,
    webEnvironment: values.webEnvironment,
    renderer,
    localRendererSha256: "c".repeat(64),
    venueProfile: sixCameraProfile,
    agentTokens
  });

  assert.match(files["ingest.env"], /MEDIAMTX_COURT_6_RAW_SOURCE="publisher"/);
  assert.match(files["ingest.env"], /MEDIAMTX_COURT_7_RAW_SOURCE="publisher"/);
  assert.match(files["ingest.env"], /MEDIAMTX_COURT_8_RAW_SOURCE="publisher"/);
});

test("fails closed on duplicate output ownership, incomplete camera credentials, and Twilio residue", () => {
  const duplicate = fixture();
  duplicate.compositorEnvironments[1].COURT_1_YOUTUBE_KEY = "duplicate-youtube-key-abcdefghijk";
  assert.throws(() => buildProductionMaterial(duplicate), /exactly one protected YouTube stream key owner/);

  const missing = fixture();
  missing.globalConfig.authInternalUsers.pop();
  assert.throws(() => buildProductionMaterial(missing), /Camera 8 must have exactly one publisher credential/);

  const twilio = fixture();
  twilio.monitoringEnvironment.TWILIO_ACCOUNT_SID = "must-not-survive";
  assert.throws(() => buildProductionMaterial(twilio), /must not contain Twilio credentials/);

  const duplicateStream = fixture();
  duplicateStream.compositorEnvironments[1].COURT_3_YOUTUBE_STREAM_ID = "youtube-stream-1";
  assert.throws(() => buildProductionMaterial(duplicateStream), /stream identities are not unique/);
});

test("migrates the qualified legacy 720 material to reusable variable YouTube streams without retaining fixed output dimensions", () => {
  const current = buildProductionMaterial(fixture());
  const legacyMaterial = {
    ...current,
    schemaVersion: 1,
    compositors: Object.fromEntries(Object.entries(current.compositors).map(([court, compositor]) => [court, {
      apiKey: compositor.apiKey,
      apiSecret: compositor.apiSecret,
      rtmpsBase: "rtmps://legacy.example/live2",
      streamKey: `legacy-stream-key-${court}`,
      encoding: { width: "1280", height: "720", framerate: "30", videoBitrate: "4000", audioBitrate: "128", audioFrequency: "48000", keyframeInterval: "2" }
    }]))
  };
  const destinations = destinationFixture();
  const migrated = migrateProductionMaterial({ legacyMaterial, destinations });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.compositors[1].streamId, "production-stream-1");
  assert.equal(migrated.compositors[1].youtubeResolution, "variable");
  assert.deepEqual(migrated.compositors[1].outputProfiles, ["1080p30", "1080p60"]);
  assert.equal("encoding" in migrated.compositors[1], false);
});

test("rotates reusable YouTube destinations on current material without changing camera, renderer, or commentary ownership", () => {
  const current = buildProductionMaterial(fixture());
  const rotated = replaceProductionDestinations({ material: current, destinations: destinationFixture("rotated") });

  assert.equal(rotated.compositors[1].streamId, "rotated-stream-1");
  assert.equal(rotated.compositors[8].streamKey, "rotated-stream-key-8");
  assert.deepEqual(rotated.publishers, current.publishers);
  assert.deepEqual(rotated.commentary, current.commentary);
  assert.equal(rotated.programPageToken, current.programPageToken);
  for (let court = 1; court <= 8; court += 1) {
    assert.equal(rotated.compositors[court].apiKey, current.compositors[court].apiKey);
    assert.equal(rotated.compositors[court].apiSecret, current.compositors[court].apiSecret);
    assert.deepEqual(rotated.compositors[court].outputProfiles, ["1080p30", "1080p60"]);
  }
});

test("fails closed when current destination rotation receives malformed or duplicate provider ownership", () => {
  const current = buildProductionMaterial(fixture());
  const malformed = destinationFixture("malformed");
  malformed.streams[4].resolution = "1080p";
  assert.throws(() => replaceProductionDestinations({ material: current, destinations: malformed }), /Camera 4 production YouTube destination is invalid/);

  const duplicate = destinationFixture("duplicate");
  duplicate.streams[8].id = duplicate.streams[7].id;
  assert.throws(() => replaceProductionDestinations({ material: current, destinations: duplicate }), /stream identities are not unique/);
});

test("replaces the retired router heartbeat with the current Peplink monitoring contract", () => {
  const sourceEnvironment = fixture().monitoringEnvironment;
  const currentEnvironment = Object.fromEntries(Object.entries(sourceEnvironment).filter(([key]) => /^(?:MONITOR_PEPLINK_|MONITOR_UNIFI_|MONITOR_NETWORK_SWITCH_|LINOVISION_SNMP_)/u.test(key)));
  for (const key of Object.keys(currentEnvironment)) delete sourceEnvironment[key];
  sourceEnvironment.MONITOR_ROUTER_HEARTBEAT_TOKEN = "retired-router-heartbeat-token-abcdefghijklmnopqrstuvwxyz";
  const migrated = migrateMonitoringEnvironment({
    sourceEnvironment,
    currentEnvironment
  });
  assert.equal(migrated.MONITOR_PEPLINK_PRODUCT_CODE, "MAX-BR1-PRO-5GK-T-PRM");
  assert.equal(migrated.PUSHOVER_APP_TOKEN, sourceEnvironment.PUSHOVER_APP_TOKEN);
  assert.equal("MONITOR_ROUTER_HEARTBEAT_TOKEN" in migrated, false);
  assert.equal("MONITOR_AGENT_TARGETS" in migrated, false);
});

test("rejects missing Peplink values and Twilio residue during router monitoring migration", () => {
  const sourceEnvironment = fixture().monitoringEnvironment;
  const currentEnvironment = Object.fromEntries(Object.entries(sourceEnvironment).filter(([key]) => /^(?:MONITOR_PEPLINK_|MONITOR_UNIFI_|MONITOR_NETWORK_SWITCH_|LINOVISION_SNMP_)/u.test(key)));
  for (const key of Object.keys(currentEnvironment)) delete sourceEnvironment[key];
  sourceEnvironment.MONITOR_ROUTER_HEARTBEAT_TOKEN = "retired-router-heartbeat-token-abcdefghijklmnopqrstuvwxyz";
  delete currentEnvironment.MONITOR_PEPLINK_DEVICE_ID;
  assert.throws(() => migrateMonitoringEnvironment({ sourceEnvironment, currentEnvironment }), /MONITOR_PEPLINK_DEVICE_ID is required/);
  sourceEnvironment.TWILIO_ACCOUNT_SID = "must-not-survive";
  assert.throws(() => migrateMonitoringEnvironment({
    sourceEnvironment,
    currentEnvironment: fixture().monitoringEnvironment
  }), /must not contain Twilio credentials/);
});

test("adds the buffered HLS origin to a pre-HLS production recovery runtime", () => {
  const sourceEnvironment = fixture().webEnvironment;
  delete sourceEnvironment.MEDIAMTX_HLS_BASE_URL;
  const migrated = migrateWebRuntimeEnvironment(sourceEnvironment);
  assert.equal(migrated.MEDIAMTX_HLS_BASE_URL, sourceEnvironment.MEDIAMTX_WHEP_BASE_URL);
  assert.equal(migrated.PROGRAM_PAGE_TOKEN, sourceEnvironment.PROGRAM_PAGE_TOKEN);
});

test("rejects an existing or non-origin HLS runtime migration", () => {
  assert.throws(() => migrateWebRuntimeEnvironment(fixture().webEnvironment), /already contains/);
  const sourceEnvironment = fixture().webEnvironment;
  delete sourceEnvironment.MEDIAMTX_HLS_BASE_URL;
  sourceEnvironment.MEDIAMTX_WHEP_BASE_URL = "https://preview.example.test/whep";
  assert.throws(() => migrateWebRuntimeEnvironment(sourceEnvironment), /exact HTTPS origin/);
});
