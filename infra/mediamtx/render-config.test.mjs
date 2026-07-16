import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderMediaMtxConfigs } from "./render-config.mjs";

const mediaTemplate = await readFile(fileURLToPath(new URL("./mediamtx.template.yml", import.meta.url)), "utf8");
const caddyTemplate = await readFile(fileURLToPath(new URL("./Caddyfile.template", import.meta.url)), "utf8");
const deployScript = await readFile(fileURLToPath(new URL("./deploy.sh", import.meta.url)), "utf8");

test("renders an isolated MediaMTX public host and matching TLS health proxy", () => {
  const environment = {
    MEDIAMTX_PUBLIC_IP: "192.0.2.20",
    MEDIAMTX_PUBLIC_HOST: "preview-rehearsal-1234.beachvolleyballmedia.com",
    MEDIAMTX_CONTENT_ANALYZER_BINDINGS: JSON.stringify([
      { ip: "10.120.0.12", courts: [3, 4, 7, 8] },
      { ip: "10.120.0.11", courts: [1, 2, 5, 6] }
    ]),
    MEDIAMTX_PROGRAM_DELAY_MS: "3500"
  };
  for (let court = 1; court <= 8; court += 1) {
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_USER`] = `court${court}`;
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_PASS`] = `pass-${court}`;
  }
  const rendered = renderMediaMtxConfigs({ mediaTemplate, caddyTemplate, environment });
  assert.match(rendered.mediaConfig, /webrtcAdditionalHosts: \["192\.0\.2\.20", "preview-rehearsal-1234\.beachvolleyballmedia\.com"\]/u);
  assert.match(rendered.mediaConfig, /rtspAddress: :8554/u);
  assert.match(rendered.mediaConfig, /ips: \["10\.120\.0\.11"\][\s\S]+path: "~\^court\(1\|2\|5\|6\)_raw\$"/u);
  assert.match(rendered.mediaConfig, /ips: \["10\.120\.0\.12"\][\s\S]+path: "~\^court\(3\|4\|7\|8\)_raw\$"/u);
  assert.equal(rendered.contentAnalyzerBindingCount, 2);
  assert.equal(rendered.contentAnalyzerCourtCount, 8);
  assert.match(rendered.caddyConfig, /^preview-rehearsal-1234\.beachvolleyballmedia\.com \{/u);
  assert.match(rendered.caddyConfig, /handle \/healthz/u);
  assert.match(rendered.caddyConfig, /reverse_proxy 127\.0\.0\.1:8889/u);
  assert.doesNotMatch(rendered.mediaConfig, /__[A-Z0-9_]+__/u);
});

test("fails closed instead of defaulting a missing public hostname to production", () => {
  assert.throws(
    () => renderMediaMtxConfigs({
      mediaTemplate,
      caddyTemplate,
      environment: { MEDIAMTX_PUBLIC_IP: "192.0.2.20", MEDIAMTX_CONTENT_ANALYZER_BINDINGS: "[]" }
    }),
    /MEDIAMTX_PUBLIC_HOST is required/
  );
});

test("fails closed on absent, malformed, public, duplicated, or incomplete analyzer bindings", () => {
  const base = {
    MEDIAMTX_PUBLIC_IP: "192.0.2.20",
    MEDIAMTX_PUBLIC_HOST: "preview.example.com"
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

test("recreates only changed MediaMTX services and preserves a complete rollback baseline", () => {
  assert.match(deployScript, /installed_files=\(docker-compose\.yml mediamtx\.yml Caddyfile scorecheck-ffmpeg-runner\.sh\)/u);
  assert.match(deployScript, /cp scorecheck-ffmpeg-runner\.sh "backups\/scorecheck-ffmpeg-runner\.\$timestamp\.sh"/u);
  assert.match(deployScript, /cp "backups\/scorecheck-ffmpeg-runner\.\$timestamp\.sh" scorecheck-ffmpeg-runner\.sh/u);
  assert.match(deployScript, /services=\(mediamtx\)/u);
  assert.match(deployScript, /services\+=\(caddy\)/u);
  assert.match(deployScript, /caddy_after.*!=.*caddy_before/u);
  assert.match(deployScript, /docker compose up -d --force-recreate "\$\{services\[@\]\}"/u);
  assert.doesNotMatch(deployScript, /docker compose up -d --force-recreate\s*(?:;|\n)/u);
});
