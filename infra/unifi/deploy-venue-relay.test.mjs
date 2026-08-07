import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const script = await readFile(new URL("./deploy-venue-relay.sh", import.meta.url), "utf8");

test("pins and constrains the outbound-only venue relay", () => {
  assert.match(script, /fatedier\/frps@sha256:[a-f0-9]{64}/u);
  assert.match(script, /proxyBindAddr = \\"\$PRIVATE_IP\\"/u);
  assert.match(script, /allowPorts = \[\{ single = 1161 \}\]/u);
  assert.match(script, /transport\.tls\.force = true/u);
  assert.match(script, /--memory 64m --cpus 0\.10/u);
  assert.match(script, /ufw allow from 10\.120\.0\.0\/20/u);
  assert.match(script, /\$i > 255/u);
  assert.doesNotMatch(script, /ufw allow 1161\/udp/u);
});
