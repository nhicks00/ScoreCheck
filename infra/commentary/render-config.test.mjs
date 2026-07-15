import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderCommentaryConfigs } from "./render-config.mjs";

const livekitTemplate = await readFile(fileURLToPath(new URL("./livekit.template.yaml", import.meta.url)), "utf8");
const caddyTemplate = await readFile(fileURLToPath(new URL("./caddy.template.yaml", import.meta.url)), "utf8");

test("renders event-scoped LiveKit and Caddy hostnames without changing the reserved public address", () => {
  const rtcHost = "rtc-rehearsal-1234.beachvolleyballmedia.com";
  const turnHost = "turn-rehearsal-1234.beachvolleyballmedia.com";
  const rendered = renderCommentaryConfigs({
    livekitTemplate,
    caddyTemplate,
    apiKey: "api-key",
    apiSecret: "api-secret",
    publicIp: "192.0.2.10",
    rtcHost,
    turnHost
  });
  assert.match(rendered.livekitConfig, new RegExp(`domain: "${turnHost.replaceAll(".", "\\.")}"`));
  assert.match(rendered.caddyConfig, new RegExp(rtcHost.replaceAll(".", "\\."), "g"));
  assert.match(rendered.caddyConfig, new RegExp(turnHost.replaceAll(".", "\\."), "g"));
  assert.match(rendered.caddyConfig, /192\.0\.2\.10:5349/u);
  assert.doesNotMatch(rendered.livekitConfig, /turn\.beachvolleyballmedia\.com/u);
  assert.doesNotMatch(rendered.caddyConfig, /__[A-Z0-9_]+__/u);
});

test("fails closed when a required event hostname is absent", () => {
  assert.throws(
    () => renderCommentaryConfigs({
      livekitTemplate,
      caddyTemplate,
      apiKey: "api-key",
      apiSecret: "api-secret",
      publicIp: "192.0.2.10",
      rtcHost: "",
      turnHost: "turn.example.com"
    }),
    /rtcHost is required/
  );
});
