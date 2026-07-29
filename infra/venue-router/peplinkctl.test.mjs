import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectRouterEndpoints, grantAccessToken, loadCredentials, parseArgs, redactSensitive, remoteAdminBase, routerRequest, SNAPSHOT_ENDPOINTS } from "./peplinkctl.mjs";

const credentials = {
  clientId: "a".repeat(32),
  clientSecret: "b".repeat(32),
  deviceSerial: "293C-5441-6D74",
  tokenEndpoint: "https://api.ic.peplink.com/api/oauth2/token"
};

test("builds the stable InControl remote-admin address", () => {
  assert.equal(remoteAdminBase(credentials.deviceSerial), "https://293c-5441-6d74-ic.rwa.peplink.com");
  assert.throws(() => remoteAdminBase("not-a-serial"), /serial is invalid/u);
});

test("loads only protected credential files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scorecheck-peplink-"));
  const path = join(directory, "client.json");
  try {
    await writeFile(path, JSON.stringify(credentials), { mode: 0o644 });
    await assert.rejects(loadCredentials(path), /must not be accessible/u);
    await chmod(path, 0o600);
    assert.deepEqual(await loadCredentials(path), credentials);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses OAuth bearer authorization through the stable router tunnel", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === 1) return new Response(JSON.stringify({ access_token: "t".repeat(32) }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ stat: "ok", response: { healthy: true } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const accessToken = await grantAccessToken({ credentials, fetchImpl });
  const result = await routerRequest({ credentials, accessToken, endpoint: "status.wan.connection", method: "GET", fetchImpl });
  assert.deepEqual(result, { healthy: true });
  assert.equal(calls[1].url, "https://293c-5441-6d74-ic.rwa.peplink.com/api/status.wan.connection");
  assert.equal(calls[1].options.headers.authorization, `Bearer ${accessToken}`);
});

test("requires an explicit body and confirmation for configuration writes", () => {
  assert.throws(() => parseArgs(["post", "config.wan.connection"]), /requires --body/u);
  assert.deepEqual(parseArgs(["post", "config.wan.connection", "--body", "/tmp/request.json", "--confirm-write"]), {
    command: "post",
    credentials: `${process.env.HOME}/.config/scorecheck/peplink/incontrol-client.json`,
    endpoint: "config.wan.connection",
    body: "/tmp/request.json"
  });
});

test("accepts a complete read-only snapshot command", () => {
  assert.deepEqual(parseArgs(["snapshot"]), {
    command: "snapshot",
    credentials: `${process.env.HOME}/.config/scorecheck/peplink/incontrol-client.json`
  });
  assert.ok(SNAPSHOT_ENDPOINTS.includes("config.wan.connection"));
  assert.ok(SNAPSHOT_ENDPOINTS.includes("config.speedfusionConnectProtect"));
  assert.ok(SNAPSHOT_ENDPOINTS.includes("status.client"));
  assert.ok(SNAPSHOT_ENDPOINTS.includes("status.wan.connection.allowance"));
});

test("collects router endpoints sequentially with one access token", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const fetchImpl = async (url, options) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    calls.push({ url: String(url), authorization: options.headers.authorization });
    active -= 1;
    return new Response(JSON.stringify({ stat: "ok", response: { path: new URL(url).pathname } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const accessToken = "t".repeat(32);
  const result = await collectRouterEndpoints({
    credentials,
    accessToken,
    endpoints: ["info.firmware", "status.wan.connection"],
    fetchImpl
  });
  assert.equal(maximumActive, 1);
  assert.deepEqual(Object.keys(result), ["info.firmware", "status.wan.connection"]);
  assert.deepEqual(calls.map(({ authorization }) => authorization), [`Bearer ${accessToken}`, `Bearer ${accessToken}`]);
});

test("rejects an expired HTML router session without echoing the response body", async () => {
  const fetchImpl = async () => new Response("<html>login</html>", {
    status: 200,
    headers: { "content-type": "text/html" }
  });
  await assert.rejects(
    routerRequest({ credentials, accessToken: "t".repeat(32), endpoint: "status.wan.connection", method: "GET", fetchImpl }),
    /returned HTTP 200 with content-type text\/html/u
  );
});

test("redacts modem and credential identifiers from command output", () => {
  assert.deepEqual(redactSensitive({
    cellular: { iccid: "123", imei: "456", model: "EM9191" },
    ssid: { auth_key: "private", passphrase: "private", name: "Camera Wi-Fi" }
  }), {
    cellular: { iccid: "[REDACTED]", imei: "[REDACTED]", model: "EM9191" },
    ssid: { auth_key: "[REDACTED]", passphrase: "[REDACTED]", name: "Camera Wi-Fi" }
  });
});
