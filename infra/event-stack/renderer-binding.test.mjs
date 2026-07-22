import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureRendererBinding, loadRendererBinding, validateRendererBinding } from "./renderer-binding.mjs";

const binding = {
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

test("captures one exact renderer identity from canonical and immutable origins", async () => {
  const root = await mkdtemp(join(tmpdir(), "scorecheck-renderer-binding-"));
  const output = join(root, "renderer.json");
  const requests = [];
  const result = await captureRendererBinding({ origin: "https://score.beachvolleyballmedia.com", output }, {
    now: () => new Date("2026-07-21T12:00:00Z"),
    fetchImpl: async (url) => {
      requests.push(url);
      return { ok: true, status: 200, json: async () => binding };
    }
  });
  assert.equal(result.status, "PASS");
  assert.deepEqual(requests, [
    "https://score.beachvolleyballmedia.com/api/program/renderer-binding",
    "https://scorecheck-abc123-team.vercel.app/api/program/renderer-binding"
  ]);
  assert.equal((await loadRendererBinding(output)).capturedAt, "2026-07-21T12:00:00.000Z");
  assert.match(await readFile(output, "utf8"), /"sourceOrigin": "https:\/\/score\.beachvolleyballmedia\.com"/);
});

test("fails closed on mutable origins, identity drift, and contract drift", async () => {
  assert.throws(() => validateRendererBinding({ ...binding, origin: "https://score.beachvolleyballmedia.com" }), /generated Vercel/);
  assert.throws(() => validateRendererBinding({ ...binding, contracts: { ...binding.contracts, commentary: "v2" } }), /contract versions/);
  const root = await mkdtemp(join(tmpdir(), "scorecheck-renderer-drift-"));
  let call = 0;
  await assert.rejects(() => captureRendererBinding({ origin: "https://score.beachvolleyballmedia.com", output: join(root, "renderer.json") }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ...binding, deploymentId: call++ === 0 ? binding.deploymentId : "dpl_changed", assetNamespace: call === 1 ? binding.assetNamespace : "dpl_changed" }) })
  }), /differs/);
});
