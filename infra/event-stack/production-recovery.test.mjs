import test from "node:test";
import assert from "node:assert/strict";

import { buildEventManifest, loadManifestInputs } from "./event-manifest.mjs";
import { buildProductionMaterial, buildProductionSecretFiles } from "./production-recovery.mjs";

const inputs = await loadManifestInputs();
const manifest = buildEventManifest({ event: "production-recovery-test", kind: "production", destroyAfter: "2026-08-01", ...inputs });

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
    "HEALTHCHECKS_BASELINE_CHECK_ID", "HEALTHCHECKS_BASELINE_PING_URL", "MONITOR_API_TOKEN", "MONITOR_BROWSER_ALLOWED_ORIGINS",
    "MONITOR_BROWSER_HEARTBEAT_SECRET", "MONITOR_DASHBOARD_URL", "MONITOR_PUBLIC_HOST", "PUSHOVER_APP_TOKEN", "PUSHOVER_USER_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"
  ].map((key) => [key, `${key.toLowerCase()}-abcdefghijklmnopqrstuvwxyz`]));
  monitoringEnvironment.MONITOR_AGENT_TARGETS = "old-target-must-not-survive";
  const compositorEnvironments = Array.from({ length: 4 }, (_, index) => {
    const firstCourt = (index * 2) + 1;
    return {
      LIVEKIT_API_KEY: `local-key-${index}-1234567890`,
      LIVEKIT_API_SECRET: `local-secret-${index}-abcdefghijklmnopqrstuvwxyz`,
      PROGRAM_PAGE_TOKEN: "program-page-token-abcdefghijklmnopqrstuvwxyz",
      YOUTUBE_RTMPS_BASE: "rtmps://a.rtmps.youtube.com/live2",
      [`COURT_${firstCourt}_YOUTUBE_KEY`]: `youtube-key-${firstCourt}-abcdefghijk`,
      [`COURT_${firstCourt + 1}_YOUTUBE_KEY`]: `youtube-key-${firstCourt + 1}-abcdefghijk`,
      EGRESS_WIDTH: "1280",
      EGRESS_HEIGHT: "720",
      EGRESS_FRAMERATE: "30",
      EGRESS_VIDEO_BITRATE: "4000",
      EGRESS_AUDIO_BITRATE: "128",
      EGRESS_AUDIO_FREQUENCY: "48000",
      EGRESS_KEYFRAME_INTERVAL: "2"
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
  assert.equal(material.programPageToken, "program-page-token-abcdefghijklmnopqrstuvwxyz");
});

test("renders the exact 12-host production secret contract and strips stale target ownership", () => {
  const values = fixture();
  const material = buildProductionMaterial(values);
  const agentTokens = Object.fromEntries(manifest.droplets.map((spec, index) => [spec.name, `agent-${index}-abcdefghijklmnopqrstuvwxyz123456`]));
  const files = buildProductionSecretFiles({ manifest, material, monitoringEnvironment: values.monitoringEnvironment, agentTokens });
  assert.equal(Object.keys(files).filter((name) => name.startsWith("compositors/")).length, 9);
  assert.match(files["ingest.env"], /MEDIAMTX_COURT_8_RAW_SOURCE="srt:\/\//);
  assert.doesNotMatch(files["observability.env"], /MONITOR_AGENT_TARGETS/);
  assert.doesNotMatch(files["observability.env"], /TWILIO_/);
  assert.match(files["compositors/bvm-compositor-h.env"], /COURT_8_YOUTUBE_KEY=/);
  assert.doesNotMatch(files["compositors/bvm-compositor-h.env"], /COURT_7_YOUTUBE_KEY=/);
  assert.doesNotMatch(files["compositors/bvm-compositor-spare.env"], /COURT_[1-8]_YOUTUBE_KEY=/);
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
});
