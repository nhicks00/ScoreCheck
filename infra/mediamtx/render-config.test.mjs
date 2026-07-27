import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveOpaqueRtmpKey } from "./opaque-rtmp-key.mjs";
import { renderMediaMtxConfigs } from "./render-config.mjs";

const mediaTemplate = await readFile(fileURLToPath(new URL("./mediamtx.template.yml", import.meta.url)), "utf8");
const caddyTemplate = await readFile(fileURLToPath(new URL("./Caddyfile.template", import.meta.url)), "utf8");
const deployScript = await readFile(fileURLToPath(new URL("./deploy.sh", import.meta.url)), "utf8");
const compose = await readFile(fileURLToPath(new URL("./docker-compose.yml", import.meta.url)), "utf8");

test("runs MediaMTX under Docker init so adopted hook and probe children are reaped", () => {
  assert.match(compose, /container_name: mediamtx\n\s+init: true\n/u);
});

test("renders an isolated MediaMTX public host and matching TLS health proxy", () => {
  const environment = {
    MEDIAMTX_PUBLIC_IP: "192.0.2.20",
    MEDIAMTX_PRIVATE_IP: "10.120.0.10",
    MEDIAMTX_PUBLIC_HOST: "preview-rehearsal-1234.beachvolleyballmedia.com",
    MEDIAMTX_ACME_EMAIL: "operations@example.com",
    MEDIAMTX_CONTENT_ANALYZER_BINDINGS: JSON.stringify([
      { ip: "10.120.0.12", courts: [3, 4, 7, 8] },
      { ip: "10.120.0.11", courts: [1, 2, 5, 6] }
    ]),
    MEDIAMTX_PROGRAM_DELAY_MS: "3500"
  };
  for (let court = 1; court <= 8; court += 1) {
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_USER`] = `court${court}`;
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_PASS`] = `pass-${court}`;
    environment[`MEDIAMTX_COURT_${court}_BROWSER_SOURCE`] = court === 2 ? "normalized" : "raw";
  }
  environment.MEDIAMTX_COURT_2_RTMP_PUBLISH_KEY = deriveOpaqueRtmpKey({ court: 2, user: "court2", password: "pass-2" });
  environment.MEDIAMTX_COURT_2_RTMP_APPLICATION = "root";
  environment.MEDIAMTX_COURT_3_RTMP_PUBLISH_KEY = deriveOpaqueRtmpKey({ court: 3, user: "court3", password: "pass-3" });
  const rendered = renderMediaMtxConfigs({ mediaTemplate, caddyTemplate, environment });
  assert.match(rendered.mediaConfig, /writeQueueSize: 1024/u);
  assert.match(rendered.mediaConfig, /webrtcAdditionalHosts: \["192\.0\.2\.20", "preview-rehearsal-1234\.beachvolleyballmedia\.com", "10\.120\.0\.10"\]/u);
  assert.match(rendered.mediaConfig, /rtspAddress: ":8554"/u);
  assert.match(rendered.mediaConfig, /ips: \["10\.120\.0\.11"\][\s\S]+path: "~\^court\(1\|2\|5\|6\)_raw\$"/u);
  assert.match(rendered.mediaConfig, /ips: \["10\.120\.0\.12"\][\s\S]+path: "~\^court\(3\|4\|7\|8\)_raw\$"/u);
  assert.match(rendered.mediaConfig, /action: publish\n\s+path: "~\^court\(1\|2\|5\|6\)_normalized\$"/u);
  assert.match(rendered.mediaConfig, /scorecheck-preview-runner "court\$\{G1\}_preview" "raw,normalized,raw,raw,raw,raw,raw,raw"/u);
  assert.match(rendered.mediaConfig, /scorecheck-program-runner "court\$\{G1\}_program" "raw,normalized,raw,raw,raw,raw,raw,raw" "3500000"/u);
  assert.equal(rendered.contentAnalyzerBindingCount, 2);
  assert.equal(rendered.contentAnalyzerCourtCount, 8);
  assert.equal(rendered.opaqueRtmpAliasCount, 2);
  assert.match(rendered.mediaConfig, /action: publish\n\s+path: "sc2-[A-Za-z0-9_-]{43}"/u);
  assert.match(rendered.mediaConfig, /"sc2-[A-Za-z0-9_-]{43}":\n\s+runOnReady:[\s\S]+scorecheck-ffmpeg-runner "court2_ingest"[\s\S]+rtmp:\/\/127\.0\.0\.1:1935\/court2_raw/u);
  assert.match(rendered.mediaConfig, /action: publish\n\s+path: "live\/sc3-[A-Za-z0-9_-]{43}"/u);
  assert.match(rendered.mediaConfig, /"live\/sc3-[A-Za-z0-9_-]{43}":\n\s+runOnReady:[\s\S]+scorecheck-ffmpeg-runner "court3_ingest"[\s\S]+rtmp:\/\/127\.0\.0\.1:1935\/court3_raw/u);
  assert.doesNotMatch(rendered.mediaConfig, /action: read\n\s+path: "live\/sc3-/u);
  assert.match(rendered.caddyConfig, /^preview-rehearsal-1234\.beachvolleyballmedia\.com \{/u);
  assert.match(rendered.caddyConfig, /acme\.zerossl\.com\/v2\/DV90/u);
  assert.match(rendered.caddyConfig, /acme-v02\.api\.letsencrypt\.org\/directory/u);
  assert.match(rendered.caddyConfig, /operations@example\.com/u);
  assert.match(rendered.caddyConfig, /handle \/healthz/u);
  assert.match(rendered.caddyConfig, /reverse_proxy 127\.0\.0\.1:8889/u);
  const previewRule = rendered.mediaConfig.match(/"~\^court\(\[1-8\]\)_preview\$":([\s\S]+?)runOnDemandRestart:/u)?.[1] ?? "";
  assert.match(previewRule, /scorecheck-preview-runner/u);
  assert.doesNotMatch(previewRule, /libx264|scale=|fps=/u);
  const programRule = rendered.mediaConfig.match(/"~\^court\(\[1-8\]\)_program\$":([\s\S]+?)runOnDemandRestart:/u)?.[1] ?? "";
  assert.match(programRule, /scorecheck-program-runner/u);
  assert.doesNotMatch(programRule, /court\$\{G1\}_preview/u);
  assert.doesNotMatch(programRule, /-readrate|-copyts|-use_wallclock_as_timestamps|-start_at_zero/u);
  assert.doesNotMatch(programRule, /[?&]ffs=/u);
  assert.doesNotMatch(rendered.mediaConfig, /__[A-Z0-9_]+__/u);
  assert.doesNotMatch(rendered.caddyConfig, /__[A-Z0-9_]+__/u);
});

test("rejects a malformed or cross-camera opaque RTMP key", () => {
  const environment = {
    MEDIAMTX_PUBLIC_IP: "192.0.2.20",
    MEDIAMTX_PRIVATE_IP: "10.120.0.10",
    MEDIAMTX_PUBLIC_HOST: "preview.example.com",
    MEDIAMTX_ACME_EMAIL: "operations@example.com",
    MEDIAMTX_CONTENT_ANALYZER_BINDINGS: JSON.stringify([{ ip: "10.120.0.11", courts: [1, 2, 3, 4, 5, 6, 7, 8] }])
  };
  for (let court = 1; court <= 8; court += 1) {
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_USER`] = `court${court}`;
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_PASS`] = `pass-${court}`;
    environment[`MEDIAMTX_COURT_${court}_BROWSER_SOURCE`] = "raw";
  }
  environment.MEDIAMTX_COURT_3_RTMP_PUBLISH_KEY = `sc4-${"a".repeat(43)}`;
  assert.throws(() => renderMediaMtxConfigs({ mediaTemplate, caddyTemplate, environment }), /Camera 3/u);
});

test("rejects an unsupported opaque RTMP application", () => {
  const environment = {
    MEDIAMTX_PUBLIC_IP: "192.0.2.20",
    MEDIAMTX_PRIVATE_IP: "10.120.0.10",
    MEDIAMTX_PUBLIC_HOST: "preview.example.com",
    MEDIAMTX_ACME_EMAIL: "operations@example.com",
    MEDIAMTX_CONTENT_ANALYZER_BINDINGS: JSON.stringify([{ ip: "10.120.0.11", courts: [1, 2, 3, 4, 5, 6, 7, 8] }])
  };
  for (let court = 1; court <= 8; court += 1) {
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_USER`] = `court${court}`;
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_PASS`] = `pass-${court}`;
    environment[`MEDIAMTX_COURT_${court}_BROWSER_SOURCE`] = "raw";
  }
  environment.MEDIAMTX_COURT_2_RTMP_PUBLISH_KEY = deriveOpaqueRtmpKey({ court: 2, user: "court2", password: "pass-2" });
  environment.MEDIAMTX_COURT_2_RTMP_APPLICATION = "stream";
  assert.throws(() => renderMediaMtxConfigs({ mediaTemplate, caddyTemplate, environment }), /root or live/u);
});

test("fails closed instead of defaulting a missing public hostname to production", () => {
  assert.throws(
    () => renderMediaMtxConfigs({
      mediaTemplate,
      caddyTemplate,
      environment: { MEDIAMTX_PUBLIC_IP: "192.0.2.20", MEDIAMTX_PRIVATE_IP: "10.120.0.10", MEDIAMTX_ACME_EMAIL: "operations@example.com", MEDIAMTX_CONTENT_ANALYZER_BINDINGS: "[]" }
    }),
    /MEDIAMTX_PUBLIC_HOST is required/
  );
});

test("fails closed on absent, malformed, public, duplicated, or incomplete analyzer bindings", () => {
  const base = {
    MEDIAMTX_PUBLIC_IP: "192.0.2.20",
    MEDIAMTX_PRIVATE_IP: "10.120.0.10",
    MEDIAMTX_PUBLIC_HOST: "preview.example.com",
    MEDIAMTX_ACME_EMAIL: "operations@example.com"
  };
  for (const value of [
    undefined,
    "",
    "not-json",
    JSON.stringify([{ ip: "203.0.113.11", courts: [1, 2, 3, 4, 5, 6, 7, 8] }]),
    JSON.stringify([{ ip: "10.120.0.11", courts: [1, 2, 3, 4] }, { ip: "10.120.0.11", courts: [5, 6, 7, 8] }]),
    JSON.stringify([{ ip: "10.120.0.11", courts: [1, 2, 3, 4, 5, 6, 7] }]),
    JSON.stringify([{ ip: "10.120.0.11", courts: [1, 2, 3, 4] }, { ip: "10.120.0.12", courts: [4, 5, 6, 7, 8] }])
  ]) {
    assert.throws(
      () => renderMediaMtxConfigs({
        mediaTemplate,
        caddyTemplate,
        environment: { ...base, ...(value === undefined ? {} : { MEDIAMTX_CONTENT_ANALYZER_BINDINGS: value }) }
      }),
      /content-analyzer|MEDIAMTX_CONTENT_ANALYZER_BINDINGS|Content-analyzer/u
    );
  }
});

test("fails closed on an absent or malformed ACME contact", () => {
  const base = {
    MEDIAMTX_PUBLIC_IP: "192.0.2.20",
    MEDIAMTX_PRIVATE_IP: "10.120.0.10",
    MEDIAMTX_PUBLIC_HOST: "preview.example.com",
    MEDIAMTX_CONTENT_ANALYZER_BINDINGS: JSON.stringify([{ ip: "10.120.0.11", courts: [1, 2, 3, 4, 5, 6, 7, 8] }])
  };
  for (const value of [undefined, "", "not-an-email"]) {
    assert.throws(
      () => renderMediaMtxConfigs({ mediaTemplate, caddyTemplate, environment: { ...base, ...(value === undefined ? {} : { MEDIAMTX_ACME_EMAIL: value }) } }),
      /MEDIAMTX_ACME_EMAIL/u
    );
  }
});

test("fails closed when the ingest ICE candidate is not private", () => {
  assert.throws(
    () => renderMediaMtxConfigs({
      mediaTemplate,
      caddyTemplate,
      environment: {
        MEDIAMTX_PUBLIC_IP: "192.0.2.20",
        MEDIAMTX_PRIVATE_IP: "203.0.113.20",
        MEDIAMTX_PUBLIC_HOST: "preview.example.com",
        MEDIAMTX_ACME_EMAIL: "operations@example.com",
        MEDIAMTX_CONTENT_ANALYZER_BINDINGS: JSON.stringify([{ ip: "10.120.0.11", courts: [1, 2, 3, 4, 5, 6, 7, 8] }])
      }
    }),
    /MEDIAMTX_PRIVATE_IP/u
  );
});

test("recreates only changed MediaMTX services and preserves a complete rollback baseline", () => {
  assert.match(deployScript, /installed_files=\(docker-compose\.yml mediamtx\.yml Caddyfile scorecheck-ffmpeg-runner\.sh scorecheck-preview-runner\.sh\)/u);
  assert.match(deployScript, /cp scorecheck-ffmpeg-runner\.sh "backups\/scorecheck-ffmpeg-runner\.\$timestamp\.sh"/u);
  assert.match(deployScript, /cp scorecheck-preview-runner\.sh "backups\/scorecheck-preview-runner\.\$timestamp\.sh"/u);
  assert.match(deployScript, /if \[\[ -f scorecheck-program-runner\.sh \]\]; then[\s\S]*had_previous_program_runner=1/u);
  assert.match(deployScript, /if \[\[ -f recovery-role\.sh \]\]; then[\s\S]*had_previous_recovery_role=1[\s\S]*had_previous_recovery_role=0/u);
  assert.match(deployScript, /cp "backups\/scorecheck-ffmpeg-runner\.\$timestamp\.sh" scorecheck-ffmpeg-runner\.sh/u);
  assert.match(deployScript, /if \[\[ "\$had_previous_program_runner" -eq 1 \]\]; then[\s\S]*else[\s\S]*rm -f scorecheck-program-runner\.sh/u);
  assert.match(deployScript, /if \[\[ "\$had_previous_recovery_role" -eq 1 \]\]; then[\s\S]*else[\s\S]*rm -f recovery-role\.sh/u);
  assert.match(deployScript, /services=\(mediamtx\)/u);
  assert.match(deployScript, /docker compose --project-directory "\$REMOTE_DIR" -f docker-compose\.yml config --hash caddy/u);
  assert.match(deployScript, /docker compose --project-directory "\$REMOTE_DIR" -f \.incoming\/docker-compose\.yml config --hash caddy/u);
  assert.match(deployScript, /caddy_service_changed=0/u);
  assert.match(deployScript, /if \[\[ "\$DEPLOY_MODE" == "staged" \|\| "\$had_previous" -eq 0/u);
  assert.match(deployScript, /"\$caddy_service_changed" -eq 1/u);
  assert.match(deployScript, /services\+=\(caddy\)/u);
  assert.match(deployScript, /if \[\[ "\$DEPLOY_MODE" == "active" && "\$had_previous" -eq 1 && -z "\$caddy_before" \]\]/u);
  assert.match(deployScript, /caddy_after.*!=.*caddy_before/u);
  assert.match(deployScript, /docker compose up -d --force-recreate "\$\{services\[@\]\}"/u);
  assert.doesNotMatch(deployScript, /docker compose up -d --force-recreate\s*(?:;|\n)/u);
  assert.match(compose, /environment:\s+SRT_PORT: "8890"/u);
  assert.match(deployScript, /--retry 60[\s\S]*--retry-max-time 300/u);
  assert.match(deployScript, /docker compose logs --tail=120 caddy/u);
});
