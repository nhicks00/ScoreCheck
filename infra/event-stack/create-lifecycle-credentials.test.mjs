import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLifecycleCredentials, parseCredentialArgs } from "./create-lifecycle-credentials.mjs";

const PROVIDER = {
  DIGITALOCEAN_TOKEN: "old-do-token",
  SCORECHECK_DO_SSH_KEYS: "123,456",
  VERCEL_TOKEN: "vercel-token",
  VERCEL_TEAM_ID: "team-id"
};
const MONITORING = {
  YOUTUBE_CLIENT_ID: "youtube-client",
  YOUTUBE_CLIENT_SECRET: "youtube-secret",
  YOUTUBE_REFRESH_TOKEN: "youtube-refresh",
  PUSHOVER_APP_TOKEN: "pushover-app",
  PUSHOVER_USER_KEY: "pushover-user",
  TWILIO_AUTH_TOKEN: "must-not-be-copied"
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-lifecycle-credentials-"));
  await chmod(root, 0o700);
  const providerEnv = join(root, "provider.env");
  const monitoringEnv = join(root, "monitoring.env");
  const tokenFile = join(root, "do-token");
  const output = join(root, "lifecycle.env");
  await writeFile(providerEnv, env(PROVIDER), { mode: 0o600 });
  await writeFile(monitoringEnv, env(MONITORING), { mode: 0o600 });
  await writeFile(tokenFile, "new-do-token\n", { mode: 0o600 });
  return { command: "create", providerEnv, monitoringEnv, digitalOceanTokenFile: tokenFile, output };
}

test("atomically creates the exact Pushover-only lifecycle credential contract", async () => {
  const options = await fixture();
  const result = await createLifecycleCredentials(options);
  const output = await readFile(options.output, "utf8");
  assert.equal(result.digitalOceanTokenSource, "protected-token-file");
  assert.match(output, /^DIGITALOCEAN_TOKEN=new-do-token$/mu);
  assert.match(output, /^YOUTUBE_REFRESH_TOKEN=youtube-refresh$/mu);
  assert.match(output, /^PUSHOVER_USER_KEY=pushover-user$/mu);
  assert.doesNotMatch(output, /TWILIO/u);
  assert.equal((await stat(options.output)).mode & 0o077, 0);
  await assert.rejects(() => createLifecycleCredentials(options), /already exists/);
  assert.equal(await readFile(options.output, "utf8"), output);
});

test("uses the protected provider token when no replacement token file is supplied", async () => {
  const options = await fixture();
  const result = await createLifecycleCredentials({ ...options, digitalOceanTokenFile: null });
  assert.equal(result.digitalOceanTokenSource, "provider-env");
  assert.match(await readFile(options.output, "utf8"), /^DIGITALOCEAN_TOKEN=old-do-token$/mu);
});

test("fails closed on weak files, missing values, relative paths, and path aliasing", async () => {
  const weak = await fixture();
  await chmod(weak.digitalOceanTokenFile, 0o644);
  await assert.rejects(() => createLifecycleCredentials(weak), /token file must be mode 0600/);

  const missing = await fixture();
  await writeFile(missing.monitoringEnv, "PUSHOVER_APP_TOKEN=only-one-key\n", { mode: 0o600 });
  await assert.rejects(() => createLifecycleCredentials(missing), /YOUTUBE_CLIENT_ID is missing/);

  assert.throws(() => parseCredentialArgs(["create", "--provider-env", "relative"]), /normalized absolute path/);
  const aliased = await fixture();
  await assert.rejects(() => createLifecycleCredentials({ ...aliased, output: aliased.providerEnv }), /paths must be distinct/);
});

function env(value) {
  return `${Object.entries(value).map(([key, entry]) => `${key}=${entry}`).join("\n")}\n`;
}
