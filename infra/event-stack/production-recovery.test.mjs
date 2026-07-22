import test from "node:test";
import assert from "node:assert/strict";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { buildProductionMaterial, buildProductionSecretFiles, migrateMonitoringEnvironment, migrateProductionMaterial } from "./production-recovery.mjs";
import { createSyntheticRehearsalVenueProfile } from "./venue-admission.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "production-recovery-test", kind: "production", destroyAfter: "2026-08-01", ...inputs });
const venueProfile = createSyntheticRehearsalVenueProfile(manifest.event);
venueProfile.cameras[1] = {
  ...venueProfile.cameras[1],
  sourcePathMode: "isolated-hevc-normalizer",
  sourceCodec: "H265"
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
    browserHeartbeat: "browser-heartbeat-v5"
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
    LIVEKIT_COMMENTARY_API_SECRET: "commentary-secret-abcdefghijklmnopqrstuvwxyz"
  };
  const monitoringEnvironment = Object.fromEntries([
    "ALERTMANAGER_WEBHOOK_TOKEN", "HEALTHCHECKS_ACTIVE_CHECK_ID", "HEALTHCHECKS_ACTIVE_PING_URL", "HEALTHCHECKS_API_KEY",
    "HEALTHCHECKS_BASELINE_CHECK_ID", "HEALTHCHECKS_BASELINE_PING_URL", "HEALTHCHECKS_SENTINEL_PING_URL", "MONITOR_API_TOKEN", "MONITOR_BROWSER_ALLOWED_ORIGINS",
    "MONITOR_BROWSER_HEARTBEAT_SECRET", "MONITOR_DASHBOARD_URL", "MONITOR_PUBLIC_HOST", "PUSHOVER_APP_TOKEN", "PUSHOVER_USER_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"
  ].map((key) => [key, `${key.toLowerCase()}-abcdefghijklmnopqrstuvwxyz`]));
  monitoringEnvironment.HEALTHCHECKS_BASELINE_PING_URL = "https://hc-ping.com/monitor-baseline";
  monitoringEnvironment.HEALTHCHECKS_ACTIVE_PING_URL = "https://hc-ping.com/monitor-active";
  monitoringEnvironment.HEALTHCHECKS_SENTINEL_PING_URL = "https://hc-ping.com/platform-sentinel";
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
  const files = buildProductionSecretFiles({ manifest, material, monitoringEnvironment: values.monitoringEnvironment, renderer, venueProfile, agentTokens });
  assert.equal(Object.keys(files).filter((name) => name.startsWith("compositors/")).length, 9);
  assert.match(files["ingest.env"], /MEDIAMTX_COURT_8_RAW_SOURCE="srt:\/\//);
  assert.match(files["ingest.env"], /MEDIAMTX_COURT_1_BROWSER_SOURCE="raw"/);
  assert.match(files["ingest.env"], /MEDIAMTX_COURT_2_BROWSER_SOURCE="normalized"/);
  assert.doesNotMatch(files["observability.env"], /MONITOR_AGENT_TARGETS/);
  assert.doesNotMatch(files["observability.env"], /TWILIO_/);
  assert.match(files["compositors/bvm-compositor-h.env"], /COURT_8_YOUTUBE_KEY=/);
  assert.match(files["compositors/bvm-compositor-h.env"], /COURT_8_YOUTUBE_STREAM_ID=/);
  assert.match(files["compositors/bvm-compositor-h.env"], /YOUTUBE_STREAM_RESOLUTION="variable"/);
  assert.match(files["compositors/bvm-compositor-h.env"], /PRODUCTION_OUTPUT_PROFILES="1080p30,1080p60"/);
  assert.match(files["compositors/bvm-compositor-h.env"], /PROGRAM_PAGE_BASE_URL="https:\/\/scorecheck-abc123-team\.vercel\.app\/program"/);
  assert.match(files["compositors/bvm-compositor-h.env"], /PROGRAM_RENDERER_DEPLOYMENT_ID="dpl_renderer123"/);
  assert.match(files["compositors/bvm-compositor-b.env"], /CAMERA_NORMALIZER_ENABLED="true"/);
  assert.match(files["compositors/bvm-compositor-b.env"], /CAMERA_SOURCE_CODEC="H265"/);
  assert.match(files["compositors/bvm-compositor-a.env"], /CAMERA_NORMALIZER_ENABLED="false"/);
  assert.match(files["observability.env"], /MONITOR_BROWSER_ALLOWED_ORIGINS="https:\/\/scorecheck-abc123-team\.vercel\.app"/);
  assert.match(files["observability.env"], /HEALTHCHECKS_SENTINEL_PING_URL=/);
  assert.doesNotMatch(files["compositors/bvm-compositor-h.env"], /EGRESS_(WIDTH|HEIGHT|FRAMERATE|VIDEO_BITRATE)/);
  assert.doesNotMatch(files["compositors/bvm-compositor-h.env"], /COURT_7_YOUTUBE_KEY=/);
  assert.doesNotMatch(files["compositors/bvm-compositor-spare.env"], /COURT_[1-8]_YOUTUBE_KEY=/);
  assert.doesNotMatch(files["compositors/bvm-compositor-spare.env"], /CAMERA_NUMBER=/);
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
  const destinations = {
    schemaVersion: 1,
    streams: Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
      const court = index + 1;
      return [court, {
        id: `production-stream-${court}`,
        court,
        resolution: "variable",
        frameRate: "variable",
        streamName: `production-stream-key-${court}`,
        rtmpsIngestionAddress: "rtmps://a.rtmps.youtube.com/live2"
      }];
    }))
  };
  const migrated = migrateProductionMaterial({ legacyMaterial, destinations });
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.compositors[1].streamId, "production-stream-1");
  assert.equal(migrated.compositors[1].youtubeResolution, "variable");
  assert.deepEqual(migrated.compositors[1].outputProfiles, ["1080p30", "1080p60"]);
  assert.equal("encoding" in migrated.compositors[1], false);
});

test("adds only a distinct dedicated Healthchecks sentinel to a pre-sentinel recovery environment", () => {
  const sourceEnvironment = fixture().monitoringEnvironment;
  delete sourceEnvironment.HEALTHCHECKS_SENTINEL_PING_URL;
  const migrated = migrateMonitoringEnvironment({
    sourceEnvironment,
    currentEnvironment: { HEALTHCHECKS_SENTINEL_PING_URL: "https://hc-ping.com/platform-sentinel" }
  });
  assert.equal(migrated.HEALTHCHECKS_SENTINEL_PING_URL, "https://hc-ping.com/platform-sentinel");
  assert.equal(migrated.PUSHOVER_APP_TOKEN, sourceEnvironment.PUSHOVER_APP_TOKEN);
  assert.equal("MONITOR_AGENT_TARGETS" in migrated, false);
});

test("rejects an existing sentinel, dead-man reuse, malformed URLs, and Twilio residue during sentinel migration", () => {
  const sourceEnvironment = fixture().monitoringEnvironment;
  assert.throws(() => migrateMonitoringEnvironment({ sourceEnvironment, currentEnvironment: sourceEnvironment }), /already contains/);

  delete sourceEnvironment.HEALTHCHECKS_SENTINEL_PING_URL;
  assert.throws(() => migrateMonitoringEnvironment({
    sourceEnvironment,
    currentEnvironment: { HEALTHCHECKS_SENTINEL_PING_URL: sourceEnvironment.HEALTHCHECKS_ACTIVE_PING_URL }
  }), /must not reuse/);
  assert.throws(() => migrateMonitoringEnvironment({
    sourceEnvironment,
    currentEnvironment: { HEALTHCHECKS_SENTINEL_PING_URL: "http://hc-ping.com/not-secure" }
  }), /must be HTTPS/);

  sourceEnvironment.TWILIO_ACCOUNT_SID = "must-not-survive";
  assert.throws(() => migrateMonitoringEnvironment({
    sourceEnvironment,
    currentEnvironment: { HEALTHCHECKS_SENTINEL_PING_URL: "https://hc-ping.com/platform-sentinel" }
  }), /must not contain Twilio credentials/);
});
