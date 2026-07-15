import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderMediaMtxConfigs } from "./render-config.mjs";

const mediaTemplate = await readFile(fileURLToPath(new URL("./mediamtx.template.yml", import.meta.url)), "utf8");
const caddyTemplate = await readFile(fileURLToPath(new URL("./Caddyfile.template", import.meta.url)), "utf8");

test("renders an isolated MediaMTX public host and matching TLS health proxy", () => {
  const environment = {
    MEDIAMTX_PUBLIC_IP: "192.0.2.20",
    MEDIAMTX_PUBLIC_HOST: "preview-rehearsal-1234.beachvolleyballmedia.com",
    MEDIAMTX_PROGRAM_DELAY_MS: "3500"
  };
  for (let court = 1; court <= 8; court += 1) {
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_USER`] = `court${court}`;
    environment[`MEDIAMTX_COURT_${court}_PUBLISH_PASS`] = `pass-${court}`;
  }
  const rendered = renderMediaMtxConfigs({ mediaTemplate, caddyTemplate, environment });
  assert.match(rendered.mediaConfig, /webrtcAdditionalHosts: \["192\.0\.2\.20", "preview-rehearsal-1234\.beachvolleyballmedia\.com"\]/u);
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
      environment: { MEDIAMTX_PUBLIC_IP: "192.0.2.20" }
    }),
    /MEDIAMTX_PUBLIC_HOST is required/
  );
});
