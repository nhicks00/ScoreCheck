import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRequest, parseArgs } from "./cloud-controller.mjs";

test("parses an explicitly confirmed controller creation", () => {
  assert.deepEqual(parseArgs([
    "up",
    "--credentials-env", "/tmp/provider.env",
    "--state", "/tmp/unifi-state.json",
    "--confirm", "CREATE:PERSISTENT-UNIFI-CONTROLLER"
  ]), {
    command: "up",
    credentialsEnv: "/tmp/provider.env",
    state: "/tmp/unifi-state.json",
    confirm: "CREATE:PERSISTENT-UNIFI-CONTROLLER"
  });
});

test("refuses controller creation without the exact confirmation", () => {
  assert.throws(() => parseArgs([
    "up",
    "--credentials-env", "/tmp/provider.env",
    "--state", "/tmp/unifi-state.json"
  ]), /confirmation must be exactly/u);
});

test("refuses controller destruction without the exact confirmation", () => {
  assert.throws(() => parseArgs([
    "destroy",
    "--credentials-env", "/tmp/provider.env",
    "--state", "/tmp/unifi-state.json"
  ]), /confirmation must be exactly/u);
});

test("builds the minimum supported persistent controller request", () => {
  assert.deepEqual(buildRequest({ sshKeys: ["123"], cloudInitSha256: "a".repeat(64) }), {
    name: "bvm-unifi-controller",
    region: "sfo2",
    vpcUuid: "6ece4819-6f6a-4ab9-934c-f6a92660aab2",
    size: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    sshKeys: ["123"],
    tags: ["scorecheck-role:unifi-controller", "scorecheck-persistent"],
    userDataProfile: "unifi",
    userDataSha256: "a".repeat(64)
  });
});

test("provisions only the required public controller services", async () => {
  const cloudInit = await readFile(new URL("./cloud-init.yaml", import.meta.url), "utf8");
  assert.match(cloudInit, /- nginx\n/u);
  assert.match(cloudInit, /proxy_pass https:\/\/127\.0\.0\.1:11443;/u);
  assert.match(cloudInit, /ufw allow 80\/tcp/u);
  assert.match(cloudInit, /ufw allow 443\/tcp/u);
  assert.doesNotMatch(cloudInit, /ufw allow 11443/u);
});
